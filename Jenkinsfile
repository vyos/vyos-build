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

// Returns true if this is a custom build launched on any project fork,
// returns false if this is build from git@github.com:vyos/vyos-build.git
def isCustomBuild() {
    def gitURI = "git@github.com:vyos/vyos-build.git"
    def httpURI = "https://github.com/vyos/vyos-build.git"

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

def setGitHubStatus(state, description) {
    if (isCustomBuild())
        return

    withCredentials([string(credentialsId: 'GitHub-API-Token', variable: 'TOKEN')]) {
        def commitId = sh(returnStdout: true, script: "git rev-parse HEAD").trim()
        def postBody = [
                state: "${state}",
                target_url: "${BUILD_URL}",
                description: "${description}",
                context: 'continuous-integration/jenkins',
        ]
        def postBodyString = groovy.json.JsonOutput.toJson(postBody)
        sh "curl 'https://api.github.com/repos/vyos/vyos-build/statuses/${commitId}?access_token=${TOKEN}' \
                -H 'Content-Type: application/json' -X POST -d '${postBodyString}' -k"
    }
}

/* Only keep the 10 most recent builds. */
def projectProperties = [
    [$class: 'BuildDiscarderProperty',strategy: [$class: 'LogRotator', numToKeepStr: '1']],
]

properties(projectProperties)
setDescription()

pipeline {
    options {
        disableConcurrentBuilds()
        timeout(time: 90, unit: 'MINUTES')
        parallelsAlwaysFailFast()
    }
    triggers {
        cron('H 2 * * *')
    }
    agent {
        dockerfile {
            filename 'Dockerfile'
            label 'jessie-amd64'
            dir 'docker'
            args '--privileged --sysctl net.ipv6.conf.lo.disable_ipv6=0 -e GOSU_UID=1006 -e GOSU_GID=1006'
        }
    }
    stages {
        stage('Configure') {
            steps {
                script {
                    setGitHubStatus("pending", "Build is pending.")
                    sh """
                        ./configure --build-by="autobuild@vyos.net" --debian-mirror="http://ftp.us.debian.org/debian/"
                    """
                }
            }
        }
        stage('Build') {
            steps {
                sh """
                    sudo make iso
                """
            }
        }
        stage('Test') {
            steps {
                sh """
                    sudo apt-get update && sudo apt-get install -y python3-pexpect qemu-kvm 
                    cd build/ 
                    sudo ../scripts/check-qemu-install --debug live-image-amd64.hybrid.iso
                """
            }
        }
    }
    post {
        success {
            script {
                // only deploy ISO if build from official repository
                if (isCustomBuild())
                    return

                // publish build result, using SSH-dev.packages.vyos.net Jenkins Credentials
                sshagent(['SSH-dev.packages.vyos.net']) {
                    // build up some fancy groovy variables so we do not need to write/copy
                    // every option over and over again!
                    def ARCH = sh(returnStdout: true, script: "dpkg --print-architecture").trim()
                    def SSH_DIR = '/home/sentrium/web/downloads.vyos.io/public_html/rolling/' + getGitBranchName() + '/' + ARCH
                    def SSH_OPTS = '-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no'
                    def SSH_REMOTE = 'khagen@10.217.48.113'

                    // No need to explicitly check the return code. The pipeline
                    // will fail if sh returns a non 0 exit code
                    sh """
                        ssh ${SSH_OPTS} ${SSH_REMOTE} -t "bash --login -c 'mkdir -p ${SSH_DIR}'"
                    """
                    sh """
                        ssh ${SSH_OPTS} ${SSH_REMOTE} -t "bash --login -c 'mkdir -p ${SSH_DIR}'"
                    """
                    sh """
                        ssh ${SSH_OPTS} ${SSH_REMOTE} -t "bash --login -c 'find ${SSH_DIR} -type f -mtime +14 -exec rm -f {} \\;'"
                    """
                    sh """
                        scp ${SSH_OPTS} build/vyos*.iso ${SSH_REMOTE}:${SSH_DIR}/
                    """
                }

                setGitHubStatus("success", "Build has succeeded!")
            }
        }
        failure {
            script {
                // only deploy ISO if build from official repository
                if (isCustomBuild())
                    return

                setGitHubStatus("failure", "Build has failed!")
            }
        }
        cleanup {
            echo 'One way or another, I have finished'
            // the 'build' directory got elevated permissions during the build
            // cdjust permissions so it can be cleaned up by the regular user
            sh '''
                #!/bin/bash
                if [ -d build ]; then
                    sudo chmod -R 777 build/
                fi
            '''
            deleteDir() /* cleanup our workspace */
        }
    }
}
