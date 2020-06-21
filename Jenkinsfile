#!/usr/bin/env groovy
// Copyright (C) 2019 VyOS maintainers and contributors
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

@NonCPS

def getGitBranchName() {
    def branch = scm.branches[0].name
    return branch.split('/')[-1]
}

def getGitRepoURL() {
    return scm.userRemoteConfigs[0].url
}

def getGitRepoName() {
    return getGitRepoURL().split('/').last()
}

// Returns true if this is a custom build launched on any project fork.
// Returns false if this is build from git@github.com:vyos/<reponame>.
// <reponame> can be e.g. vyos-1x.git or vyatta-op.git
def isCustomBuild() {
    // GitHub organisation base URL
    def gitURI = 'git@github.com:vyos/' + getGitRepoName()
    def httpURI = 'https://github.com/vyos/' + getGitRepoName()

    return ! ((getGitRepoURL() == gitURI) || (getGitRepoURL() == httpURI))
}

def setDescription() {
    def item = Jenkins.instance.getItemByFullName(env.JOB_NAME)

    // build up the main description text
    def description = ""
    description += "<h2>Build VyOS ISO image</h2>"

    if (isCustomBuild()) {
        description += "<p style='border: 3px dashed red; width: 50%;'>"
        description += "<b>Build not started from official Git repository!</b><br>"
        description += "<br>"
        description += "Repository: <font face = 'courier'>" + getGitRepoURL() + "</font><br>"
        description += "Branch: <font face = 'courier'>" + getGitBranchName() + "</font><br>"
        description += "</p>"
    } else {
        description += "Sources taken from Git branch: <font face = 'courier'>" + getGitBranchName() + "</font><br>"
    }

    item.setDescription(description)
    item.save()
}

// Only keep the 10 most recent builds
def projectProperties = [
    [$class: 'BuildDiscarderProperty',strategy: [$class: 'LogRotator', numToKeepStr: '10']],
]

properties(projectProperties)
setDescription()

// Due to long build times on DockerHub we rather build the container by ourself
// and publish it later on.

// create container names on demand
env.DOCKER_IMAGE =       "vyos/vyos-build:" + getGitBranchName()
env.DOCKER_IMAGE_ARM =   "vyos/vyos-build:" + getGitBranchName() + "-armhf"
env.DOCKER_IMAGE_ARM64 = "vyos/vyos-build:" + getGitBranchName() + "-arm64"

node('Docker') {
    stage('Fetch') {
        git branch: getGitBranchName(),
            url: getGitRepoURL()
    }
    stage('Build Docker container') {
        parallel (
            'x86-64': {
                script {
                    dir('docker') {
                        sh """
                            mkdir -p x86-64
                            cp Dockerfile x86-64/Dockerfile
                            cp entrypoint.sh x86-64/entrypoint.sh

                            docker build -t ${env.DOCKER_IMAGE} x86-64
                        """
                        if ( ! isCustomBuild()) {
                            withDockerRegistry([credentialsId: "DockerHub"]) {
                                sh "docker push ${env.DOCKER_IMAGE}"
                            }

                        }
                    }
                }
            },
//          'armhf': {
//              script {
//                  dir('docker') {
//                      sh """
//                          cp Dockerfile armhf/Dockerfile
//                          cp entrypoint.sh armhf/entrypoint.sh
//                          sed -i 's#^FROM.*#FROM multiarch/debian-debootstrap:armhf-buster-slim#' armhf/Dockerfile
//                          docker build -t ${env.DOCKER_IMAGE_ARM} armhf
//                      """
//                      if ( ! isCustomBuild()) {
//                          withDockerRegistry([credentialsId: "DockerHub"]) {
//                              sh "docker push ${env.DOCKER_IMAGE_ARM}"
//                          }
//                      }
//                  }
//              }
//          },
//          'arm64': {
//              script {
//                  dir('docker') {
//                      sh """
//                          cp Dockerfile arm64/Dockerfile
//                          cp entrypoint.sh arm64/entrypoint.sh
//                          sed -i 's#^FROM.*#FROM multiarch/debian-debootstrap:arm64-buster-slim#' arm64/Dockerfile
//                          docker build -t ${env.DOCKER_IMAGE_ARM64} arm64
//
//                      """
//
//                      if ( ! isCustomBuild()) {
//                          withDockerRegistry([credentialsId: "DockerHub"]) {
//                              sh "docker push ${env.DOCKER_IMAGE_ARM64}"
//
//                          }
//                      }
//                  }
//              }
//          }
        )
    }
}

pipeline {
    options {
        skipDefaultCheckout()
        disableConcurrentBuilds()
        timeout(time: 120, unit: 'MINUTES')
        parallelsAlwaysFailFast()
        timestamps()
    }
    triggers {
        cron('H 2 * * *')
    }
    agent {
        dockerfile {
            filename 'Dockerfile'
            dir 'docker'
            args '--privileged --sysctl net.ipv6.conf.lo.disable_ipv6=0 -e GOSU_UID=1006 -e GOSU_GID=1006'
        }
    }
    stages {
        stage('Build ISO') {
            when {
                beforeOptions true
                beforeAgent true
                anyOf {
                    // Do not run ISO build when the Docker container definition or
                    // the build pipeline library changes as this has no direct impact
                    // on the ISO image.
                    not {
                        changeset "**/docker/*"
                        changeset "**/vars/*"
                    }
                    triggeredBy 'TimerTrigger'
                    triggeredBy cause: "UserIdCause"
                }
            }
            steps {
                script {
                    // Display Git commit Id used with the Jenkinsfile on the Job "Build History" pane
                    def commitId = sh(returnStdout: true, script: 'git rev-parse --short=11 HEAD').trim()
                    currentBuild.description = sprintf('Git SHA1: %s', commitId[-11..-1])

                    sh """
                        ./configure \
                            --build-by autobuild@vyos.net \
                            --debian-mirror http://ftp.us.debian.org/debian/ \
                            --build-type release \
                            --version 1.3-rolling-\$(date +%Y%m%d%H%M)
                        sudo make iso
                    """
                }
            }
        }
        stage('Test ISO') {
            when {
                beforeOptions true
                beforeAgent true
                anyOf {
                    // Do not run ISO build when the Docker container definition or
                    // the build pipeline library changes as this has no direct impact
                    // on the ISO image.
                    not {
                        changeset "**/docker/*"
                        changeset "**/vars/*"
                    }
                    triggeredBy 'TimerTrigger'
                    triggeredBy cause: "UserIdCause"
                }
            }
            steps {
                sh "sudo make test"
            }
        }
    }
    post {
        success {
            script {
                // only deploy ISO if build from official repository
                if (isCustomBuild())
                    return

                def ARCH = sh(returnStdout: true, script: "dpkg --print-architecture").trim()

                // publish build result, using SSH-dev.packages.vyos.net Jenkins Credentials
                sshagent(['SSH-dev.packages.vyos.net']) {
                    // build up some fancy groovy variables so we do not need to write/copy
                    // every option over and over again!
                    def SSH_DIR = '/home/sentrium/web/downloads.vyos.io/public_html/rolling/' + getGitBranchName() + '/' + ARCH
                    def SSH_OPTS = '-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no'
                    def SSH_REMOTE = 'khagen@10.217.48.113'

                    // No need to explicitly check the return code. The pipeline
                    // will fail if sh returns a non 0 exit code
                    sh """
                        ssh ${SSH_OPTS} ${SSH_REMOTE} -t "bash --login -c 'mkdir -p ${SSH_DIR}'"
                        ssh ${SSH_OPTS} ${SSH_REMOTE} -t "bash --login -c 'find ${SSH_DIR} -type f -mtime +14 -exec rm -f {} \\;'"
                        scp ${SSH_OPTS} build/vyos*.iso ${SSH_REMOTE}:${SSH_DIR}/
                        ssh ${SSH_OPTS} ${SSH_REMOTE} -t "bash --login -c '/usr/bin/make-latest-rolling-symlink.sh'"
                    """
                }
                //upload to S3
                files = findFiles(glob: 'build/vyos*.iso')
                if (files) {
                    withAWS(region: 'us-east-1', credentials: 's3-vyos-downloads-rolling-rw') {
                        s3Upload(bucket: 's3-us.vyos.io',
                                 path: 'rolling/',
                                 workingDir: 'build',
                                 includePathPattern: 'vyos*.iso')
                        s3Copy(fromBucket: 's3-us.vyos.io',
                               fromPath: 'rolling/' + files[0].name,
                               toBucket: 's3-us.vyos.io',
                               toPath: 'rolling/vyos-rolling-latest.iso')
                    }
                }
            }
        }
        failure {
            archiveArtifacts artifacts: '**/live-image-amd64.hybrid.iso',
                allowEmptyArchive: true
        }
        cleanup {
            echo 'One way or another, I have finished'
            // the 'build' directory got elevated permissions during the build
            // cdjust permissions so it can be cleaned up by the regular user
            sh '''
                if [ -d build ]; then
                    sudo chmod -R 777 build/
                fi
            '''
            deleteDir() /* cleanup our workspace */
        }
    }
}
