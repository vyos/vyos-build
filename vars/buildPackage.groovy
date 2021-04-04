#!/usr/bin/env groovy
// Copyright (C) 2020-2021 VyOS maintainers and contributors
//
// This program is free software; you can redistribute it and/or modify
// in order to easy exprort images built to "external" world
// it under the terms of the GNU General Public License version 2 or later as
// published by the Free Software Foundation.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

def call(description=null, pkgList=null, buildCmd=null, buildArm=false) {
    // - description: Arbitrary text to print on Jenkins Job Description
    //   instead of package name
    // - pkgList: Multiple packages can be build at once in a single Pipeline run
    // - buildCmd: replace default build command "dpkg-buildpackage -uc -us -tc -b"
    //   with this custom version

    setDescription(description)

    pipeline {
        agent none
        options {
            disableConcurrentBuilds()
            skipDefaultCheckout()
            timeout(time: 120, unit: 'MINUTES')
            timestamps()
            buildDiscarder(logRotator(numToKeepStr: '20'))
        }
        stages {
            stage('Define Agent') {
                agent {
                    label "ec2_amd64"
                }
                steps {
                    script {
                        // create container name on demand
                        def branchName = getGitBranchName()
                        // Adjust PR target branch name so we can re-map it to the proper Docker image.
                        if (isPullRequest())
                            branchName = env.CHANGE_TARGET.toLowerCase()
                        if (branchName.equals('master'))
                            branchName = 'current'

                        env.DOCKER_IMAGE = 'vyos/vyos-build:' + branchName

                        // Get the current UID and GID from the jenkins agent to allow use of the same UID inside Docker
                        env.USR_ID = sh(returnStdout: true, script: 'id -u').toString().trim()
                        env.GRP_ID = sh(returnStdout: true, script: 'id -g').toString().trim()
                        env.DOCKER_ARGS = '--sysctl net.ipv6.conf.lo.disable_ipv6=0 -e GOSU_UID=' + env.USR_ID + ' -e GOSU_GID=' + env.GRP_ID
                    }
                }
            }
            stage('Build Code') {
                parallel {
                    stage('amd64') {
                        agent {
                            docker {
                                label "ec2_amd64"
                                args "${env.DOCKER_ARGS}"
                                image "${env.DOCKER_IMAGE}"
                                alwaysPull true
                                reuseNode true
                            }
                        }
                        environment {
                            // get relative directory path to Jenkinsfile
                            BASE_DIR = getJenkinsfilePath()
                            CHANGESET_DIR = getChangeSetPath()
                        }
                        steps {
                            script {
                                cloneAndBuild(description, 'amd64', pkgList, buildCmd)
                                stash includes: '**/*.deb', name: 'binary-amd64'
                            }
                        }
                        post {
                            cleanup {
                                deleteDir()
                            }
                        }


                    }
                    stage('arm64') {
                        agent {
                            docker {
                                label "ec2_arm64"
                                args "${env.DOCKER_ARGS}"
                                image "${env.DOCKER_IMAGE}-arm64"
                                alwaysPull true
                                reuseNode true
                            }
                        }
                        when {
                            equals expected: true, actual: buildArm
                        }
                        environment {
                            // get relative directory path to Jenkinsfile
                            BASE_DIR = getJenkinsfilePath()
                            CHANGESET_DIR = getChangeSetPath()
                        }
                        steps {
                            script {
                                cloneAndBuild(description, 'arm64', pkgList, buildCmd)
                                stash includes: '**/*arm64.deb', name: 'binary-arm64'
                            }
                        }
                        post {
                            cleanup {
                                deleteDir()
                            }
                        }
                    }
                }
            }
            stage("Finalize") {
                agent {
                    label "ec2_amd64"
                }
                steps {
                    script {
                        // Unpack files for amd64
                        unstash 'binary-amd64'

                        // Unpack files for arm64 IF they exist
                        try {
                            unstash 'binary-arm64'
                        } catch (e) {
                            print "Unstash arm64 failed, ignoring"
                        }

                        if (isCustomBuild()) {
                            echo "Build not started from official Git repository! Artifacts are not uploaded to external repository"
                            return
                        }
                        echo "Uploading Artifacts to external repository"
                        copyArtifacts fingerprintArtifacts: true, projectName: '${JOB_NAME}', selector: specific('${BUILD_NUMBER}')

                        // build up some fancy groovy variables so we do not need to write/copy
                        // every option over and over again!
                        def RELEASE = getGitBranchName()
                        if (getGitBranchName() == "master")
                            RELEASE = 'current'

                        def VYOS_REPO_PATH = '/home/sentrium/web/dev.packages.vyos.net/public_html/repositories/' + RELEASE
                        if (getGitBranchName() == "crux")
                            VYOS_REPO_PATH += '/vyos'

                        def SSH_OPTS = '-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR'
                        def SSH_REMOTE = env.DEV_PACKAGES_VYOS_NET_HOST // defined as global variable
                        def SSH_DIR = '~/VyOS/' + RELEASE

                        // publish build result, using SSH-dev.packages.vyos.net Jenkins Credentials
                        sshagent(['SSH-dev.packages.vyos.net']) {
                            files = findFiles(glob: '**/*.deb')
                            if (files) {
                                sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"bash --login -c 'mkdir -p ${SSH_DIR}'\"")
                                echo "Uploading package(s) and updating package(s) in the repository ..."
                                files.each { FILE ->
                                    // NOTE: Groovy is a pain in the ass and " quotes differ from ', so all shell code must use " in the beginning
                                    def PACKAGE = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Package").trim()
                                    def PACKAGE_ARCH = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Architecture").trim()
                                    def ARCH = ''
                                    if (PACKAGE_ARCH != 'all')
                                        ARCH = '-A ' + PACKAGE_ARCH

                                    sh(script: "scp ${SSH_OPTS} ${FILE} ${SSH_REMOTE}:${SSH_DIR}")
                                    sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} ${ARCH} remove ${RELEASE} ${PACKAGE}'\"")

                                    // Packages like FRR produce their binary in a nested path e.g. packages/frr/frr-rpki-rtrlib-dbgsym_7.5_arm64.deb,
                                    // thus we will only extract the filename portion from FILE as the binary is scp'ed to SSH_DIR without any subpath.
                                    def FILENAME = FILE.toString().tokenize('/')[-1]
                                    sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} ${ARCH} includedeb ${RELEASE} ${SSH_DIR}/${FILENAME}'\"")
                                }
                                sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} deleteunreferenced'\"")
                            }
                        }
                    }
                }
                post {
                    cleanup {
                        deleteDir()
                    }
                }
            }
        }
    }
}
