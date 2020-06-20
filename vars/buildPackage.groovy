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

def call(description, pkgList) {
    /* Only keep the 10 most recent builds. */
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
               // Adjust PR target branch name so we can re-map it to the proper
               // Docker image. CHANGE_ID is set only for pull requests, so it is
               // safe to access the pullRequest global variable
               if (env.CHANGE_ID) {
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
                args "--sysctl net.ipv6.conf.lo.disable_ipv6=0 -e GOSU_UID=1006 -e GOSU_GID=1006"
                image "${env.DOCKER_IMAGE}"
                alwaysPull true
            }
        }
        environment {
            // get relative directory path to Jenkinsfile
            BASE_DIR = currentBuild.rawBuild.parent.definition.scriptPath.replace('Jenkinsfile', '')
            CHANGESET_DIR = "**/${env.BASE_DIR}*"
            DEBIAN_ARCH = sh(returnStdout: true, script: 'dpkg --print-architecture').trim()
        }
        options {
            disableConcurrentBuilds()
            timeout(time: 60, unit: 'MINUTES')
            timestamps()
        }
        stages {
            stage('Fetch Source') {
                when {
                    beforeOptions true
                    beforeAgent true
                    anyOf {
                        changeset "${env.CHANGESET_DIR}"
                        triggeredBy 'TimerTrigger'
                        triggeredBy cause: "UserIdCause"
                    }
                }
                steps {
                    script {
                        checkout scm
                        pkgList.each { pkg ->
                            dir(pkg.name) {
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
            stage('Build Source') {
                when {
                    beforeOptions true
                    beforeAgent true
                    anyOf {
                        changeset "${env.CHANGESET_DIR}"
                        triggeredBy 'TimerTrigger'
                        triggeredBy cause: "UserIdCause"
                    }
                }
                steps {
                    script {
                        pkgList.each { pkg ->
                            dir(pkg.name) {
                                sh pkg.buildCmd
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
                            def SSH_REMOTE = 'khagen@10.217.48.113'

                            echo "Uploading package(s) and updating package(s) in the repository ..."

                            def SSH_DIR = '~/VyOS/' + RELEASE + '/' + env.DEBIAN_ARCH
                            def ARCH_OPT = ''
                            if (env.DEBIAN_ARCH != 'all')
                                ARCH_OPT = '-A ' + env.DEBIAN_ARCH

                            sh """scp ${SSH_OPTS} *.deb ${SSH_REMOTE}:${SSH_DIR}/"""

                            files = findFiles(glob: '*.deb')
                            files.each { FILE ->
                                def PKG = sh(returnStdout: true, script: "dpkg-deb -f ${FILE} Package").trim()
                                // No need to explicitly check the return code. The pipeline
                                // will fail if sh returns a noni-zero exit code
                                sh """
                                    ssh ${SSH_OPTS} ${SSH_REMOTE} "mkdir -p ${SSH_DIR}"
                                    ssh ${SSH_OPTS} ${SSH_REMOTE} "\
                                        uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} ${ARCH_OPT} remove ${RELEASE} ${PKG}'; \
                                        uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} deleteunreferenced'; \
                                        uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} ${ARCH_OPT} includedeb ${RELEASE} ${SSH_DIR}/${FILE}'; \
                                        "
                                """
                            }
                        }
                    }
                }
            }
        }
    }
}
