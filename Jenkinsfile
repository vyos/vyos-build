#!/usr/bin/env groovy

// Copyright (C) 2018 VyOS maintainers and contributors
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
    return scm.branches[0].name
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
    description += "All required Vyatta/VyOS packages are build from source prior to assembling the ISO."

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

/* Only keep the 10 most recent builds. */
def projectProperties = [
    [$class: 'BuildDiscarderProperty',strategy: [$class: 'LogRotator', numToKeepStr: '1']],
]

properties(projectProperties)
setDescription()

pipeline {
    options {
        disableConcurrentBuilds()
        timeout(time: 4, unit: 'HOURS')
        parallelsAlwaysFailFast()
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
                sh """
                    pwd
                    ./configure --build-by="autobuild@vyos.net" --debian-mirror="http://ftp.us.debian.org/debian/"
                """
            }
        }
        stage('Build') {
            steps {
                sh """
                    sudo make iso
                """
            }
        }
    }
    post {
        success {
            archiveArtifacts artifacts: 'build/live-image-*.iso', fingerprint: true
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
