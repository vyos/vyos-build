#!/usr/bin/env groovy

// Copyright (C) 2020 VyOS maintainers and contributors
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

def call(description=null, pkgList=null, buildCmd=null) {
    // - description: Arbitrary text to print on Jenkins Job Description
    //   instead of package name
    // - pkgList: Multiple packages can be build at once in a single Pipeline run
    // - buildCmd: replace default build command "dpkg-buildpackage -uc -us -tc -b"
    //   with this custom version

    // Only keep the 10 most recent builds
    def projectProperties = [
        [$class: 'BuildDiscarderProperty',strategy: [$class: 'LogRotator', numToKeepStr: '10']],
    ]

    properties(projectProperties)
    setDescription(description)

    node('Docker') {
        stage('Define Agent') {
           script {
               // create container name on demand
               def branchName = getGitBranchName()
               // Adjust PR target branch name so we can re-map it to the proper Docker image. 
               if (isPullRequest()) {
                   branchName = "${env.CHANGE_TARGET}".toLowerCase()
               }
               if (branchName.equals("master")) {
                   branchName = "current"
               }
               env.DOCKER_IMAGE = "vyos/vyos-build:" + branchName
           }
        }
    }
    pipeline {
        agent {
            docker {
                reuseNode true
                args "--sysctl net.ipv6.conf.lo.disable_ipv6=0 -e GOSU_UID=1006 -e GOSU_GID=1006"
                image "${env.DOCKER_IMAGE}"
                alwaysPull true
            }
        }
        environment {
            // get relative directory path to Jenkinsfile
            BASE_DIR = getJenkinsfilePath()
            CHANGESET_DIR = getChangeSetPath()
            DEBIAN_ARCH = sh(returnStdout: true, script: 'dpkg --print-architecture').trim()
        }
        options {
            disableConcurrentBuilds()
            skipDefaultCheckout()
            timeout(time: 60, unit: 'MINUTES')
            timestamps()
        }
        stages {
            stage('Fetch Source') {
                steps {
                    script {
                        // package build must be done in "any" subdir. Without it the Debian build system
                        // is unable to generate the *.deb files in the sources parent directory, which
                        // will cause a "Permission denied" error.
                        dir ('build') {
                            // checkout git repository which hold 'Jenkinsfile'
                            checkout scm

                            // Display Git commit Id used with the Jenkinsfile on the Job "Build History" pane
                            def commitId = sh(returnStdout: true, script: 'git rev-parse --short=11 HEAD').trim()
                            currentBuild.description = sprintf('Git SHA1: %s', commitId[-11..-1])

                            if (pkgList) {
                                // Fetch individual package source code, but only if a URL is defined, this will
                                // let us reuse this script for packages like vyos-1x which ship a Jenkinfile in
                                // their repositories root folder.
                                pkgList.each { pkg ->
                                    dir(env.BASE_DIR + pkg.name) {
                                        checkout([$class: 'GitSCM',
                                            doGenerateSubmoduleConfigurations: false,
                                            extensions: [[$class: 'CleanCheckout']],
                                            branches: [[name: pkg.scmCommit]],
                                            userRemoteConfigs: [[url: pkg.scmUrl]]])
                                    }
                                }
                            }
                        }
                    }
                }
            }
            stage('Build Source') {
                when {
                    beforeOptions true
                    beforeAgent true
                    anyOf {
                        changeset pattern: "${env.CHANGESET_DIR}"
                        expression { isPullRequest() }
                        triggeredBy 'TimerTrigger'
                        triggeredBy cause: "UserIdCause"
                    }
                }
                steps {
                    script {
                        // package build must be done in "any" subdir. Without it the Debian build system
                        // is unable to generate the *.deb files in the sources parent directory, which
                        // will cause a "Permission denied" error.
                        dir ('build') {
                            if (pkgList) {
                                pkgList.each { pkg ->
                                    dir(env.BASE_DIR + pkg.name) {
                                        sh pkg.buildCmd
                                    }
                                }
                            } else if (buildCmd) {
                                sh buildCmd
                            } else {
                                sh "dpkg-buildpackage -uc -us -tc -b"
                            }
                        }
                    }
                }
            }
        }
        post {
            cleanup {
                deleteDir()
            }
            success {
                script {
                    // package build must be done in "any" subdir. Without it the Debian build system
                    // is unable to generate the *.deb files in the sources parent directory, which
                    // will cause a "Permission denied" error.
                    def BIN_DIR = ''
                    if (env.BASE_DIR) {
                        BIN_DIR = 'build/' + env.BASE_DIR
                    }
                    dir (BIN_DIR) {
                        if (isCustomBuild()) {
                            // archive *.deb artifact on custom builds, deploy to repo otherwise
                            archiveArtifacts artifacts: '**/*.deb', allowEmptyArchive: true
                        } else {
                            // publish build result, using SSH-dev.packages.vyos.net Jenkins Credentials
                            sshagent(['SSH-dev.packages.vyos.net']) {
                                // build up some fancy groovy variables so we do not need to write/copy
                                // every option over and over again!
                                def RELEASE = getGitBranchName()
                                if (getGitBranchName() == "master") {
                                    RELEASE = 'current'
                                }

                                def VYOS_REPO_PATH = '/home/sentrium/web/dev.packages.vyos.net/public_html/repositories/' + RELEASE + '/'
                                if (getGitBranchName() == "crux")
                                    VYOS_REPO_PATH += 'vyos/'

                                def SSH_OPTS = '-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR'
                                def SSH_REMOTE = env.DEV_PACKAGES_VYOS_NET_HOST // defined as global variable

                                def SSH_DIR = '~/VyOS/' + RELEASE + '/' + env.DEBIAN_ARCH
                                def ARCH_OPT = ''
                                if (env.DEBIAN_ARCH != 'all')
                                    ARCH_OPT = '-A ' + env.DEBIAN_ARCH

                                files = findFiles(glob: '*.deb')
                                if (files) {
                                    echo "Uploading package(s) and updating package(s) in the repository ..."
                                    files.each { FILE ->
                                        def PKG = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Package").trim()
                                        // No need to explicitly check the return code. The pipeline
                                        // will fail if sh returns a noni-zero exit code
                                        sh """
                                            ssh ${SSH_OPTS} ${SSH_REMOTE} -t "bash --login -c 'mkdir -p ${SSH_DIR}'"
                                            scp ${SSH_OPTS} ${FILE} ${SSH_REMOTE}:${SSH_DIR}/
                                            ssh ${SSH_OPTS} ${SSH_REMOTE} -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} ${ARCH_OPT} remove ${RELEASE} ${PKG}'"
                                            ssh ${SSH_OPTS} ${SSH_REMOTE} -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} deleteunreferenced'"
                                            ssh ${SSH_OPTS} ${SSH_REMOTE} -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} ${ARCH_OPT} includedeb ${RELEASE} ${SSH_DIR}/${FILE}'"
                                        """
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
