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

def call(description=null, pkgList=null, buildCmd=null, buildArm=false, changesPattern="**") {
    // - description: Arbitrary text to print on Jenkins Job Description
    //   instead of package name
    // - pkgList: Multiple packages can be build at once in a single Pipeline run
    // - buildCmd: replace default build command "dpkg-buildpackage -uc -us -tc -b"
    //   with this custom version
    // - buildArm: package will also be build for the arm64 platform
    // - changesPattern: package will only be build if a change file matching this
    //   pattern is found

    setDescription(description)

    pipeline {
        agent none
        options {
            disableConcurrentBuilds()
            timeout(time: 180, unit: 'MINUTES')
            timestamps()
            buildDiscarder(logRotator(numToKeepStr: '10'))
        }
        stages {
            stage('Define Agent') {
                agent {
                    label "ec2_amd64"
                }
                when {
                    anyOf {
                        changeset "${changesPattern}"
                        triggeredBy cause: "UserIdCause"
                    }
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
                when {
                    anyOf {
                        changeset pattern: changesPattern, caseSensitive: true
                        triggeredBy cause: "UserIdCause"
                    }
                }
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
                        steps {
                            script {
                                cloneAndBuild(description, 'amd64', pkgList, buildCmd)
                                stash includes: '**/*.deb', name: 'binary-amd64', allowEmpty: true
                                try {
                                    stash includes: '**/*.dsc', name: 'source-dsc'
                                    stash includes: '**/*.tar.*z', name: 'source-tar'
                                } catch (e) {
                                    print "Stashing failed, ignoring - no source packages"
                                    currentBuild.result = 'SUCCESS'
                                }
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
                        steps {
                            script {
                                cloneAndBuild(description, 'arm64', pkgList, buildCmd)
                                stash includes: '**/*arm64.deb', name: 'binary-arm64', allowEmpty: true
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
                when {
                    anyOf {
                        changeset pattern: changesPattern, caseSensitive: true
                        triggeredBy cause: "UserIdCause"
                    }
                }
                agent {
                    label "ec2_amd64"
                }
                steps {
                    script {
                        // Unpack files for amd64, sources and arm64 if packages got build
                        try {
                            unstash 'binary-amd64'
                            unstash 'binary-arm64'
                        } catch (e) {
                            print "Unstash failed, ignoring - could be because there exists no arm64 build"
                            currentBuild.result = 'SUCCESS'
                        }
                        try {
                            unstash 'source-dsc'
                            unstash 'source-tar'
                        } catch (e) {
                            print "Unstash failed, ignoring - no source packages"
                            currentBuild.result = 'SUCCESS'
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

                        sshagent(['SSH-dev.packages.vyos.net']) {

                            sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"bash --login -c 'mkdir -p ${SSH_DIR}'\"")

                            // Removing of source and binary packages should be BEFORE adding new ones. Else "reprepro [remove/removesrc]" command may remove [source/binary] package correspondingly (behavior depends on package links).
                            // To omit this feature(bug?) do not merge removing-adding sequence by sources and binaries as it used to be
                            files = findFiles(glob: '**/*.dsc')
                            if (files) {
                                echo "Remove deprecated source package(s) from the repository..."
                                files.each { FILE ->
                                    def PACKAGE = sh(returnStdout: true, script: "cat ${FILE} | grep Source ").trim().tokenize(' ').last()
                                    sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} removesrc ${RELEASE} ${PACKAGE}'\"")
                                }
                            }

                            files = findFiles(glob: '**/*.deb')
                            if (files) {
                                echo "Remove deprecated binary package(s) from the repository..."
                                files.each { FILE ->
                                    // NOTE: Groovy is a pain in the ass and " quotes differ from ', so all shell code must use " in the beginning
                                    def PACKAGE = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Package").trim()
                                    def PACKAGE_ARCH = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Architecture").trim()
                                    def ARCH = ''
                                    if (PACKAGE_ARCH != 'all')
                                        ARCH = '-A ' + PACKAGE_ARCH
                                    sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} ${ARCH} remove ${RELEASE} ${PACKAGE}'\"")
                                }
                            }

                            files = findFiles(glob: '**/*.tar.*z')
                            if (files) {
                                echo "Uploading tarball package(s) to the repository..."
                                files.each { FILE ->
                                    sh(script: "scp ${SSH_OPTS} ${FILE} ${SSH_REMOTE}:${SSH_DIR}")
                                }
                            }

                            files = findFiles(glob: '**/*.dsc')
                            if (files) {
                                echo "Uploading *.dsc package(s) to the repository..."
                                files.each { FILE ->
                                    def PACKAGE = sh(returnStdout: true, script: "cat ${FILE} | grep Source ").trim().tokenize(' ').last()
                                    sh(script: "scp ${SSH_OPTS} ${FILE} ${SSH_REMOTE}:${SSH_DIR}")
                                    def FILENAME = FILE.toString().tokenize('/').last()
                                    sh(script: "ssh ${SSH_OPTS} ${SSH_REMOTE} -t \"uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} includedsc ${RELEASE} ${SSH_DIR}/${FILENAME}'\"")
                                }
                            }

                            files = findFiles(glob: '**/*.deb')
                            if (files) {
                                echo "Uploading binary package(s) to the repository ..."
                                files.each { FILE ->
                                    // NOTE: Groovy is a pain in the ass and " quotes differ from ', so all shell code must use " in the beginning
                                    def PACKAGE = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Package").trim()
                                    def PACKAGE_ARCH = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Architecture").trim()
                                    def ARCH = ''
                                    if (PACKAGE_ARCH != 'all')
                                        ARCH = '-A ' + PACKAGE_ARCH
                                    sh(script: "scp ${SSH_OPTS} ${FILE} ${SSH_REMOTE}:${SSH_DIR}")
                                    // Packages like FRR produce their binary in a nested path e.g. packages/frr/frr-rpki-rtrlib-dbgsym_7.5_arm64.deb,
                                    // thus we will only extract the filename portion from FILE as the binary is scp'ed to SSH_DIR without any subpath.
                                    def FILENAME = FILE.toString().tokenize('/').last()
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
