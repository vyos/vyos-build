#!/usr/bin/env groovy

@NonCPS
def setDescription() {
    def item = Jenkins.instance.getItemByFullName(env.JOB_NAME)
    item.setDescription("VyOS image build using a\nPipeline build inside Docker container.")
    item.save()
}

setDescription()

/* Only keep the 10 most recent builds. */
def projectProperties = [
    [$class: 'BuildDiscarderProperty',strategy: [$class: 'LogRotator', numToKeepStr: '5']],
]

properties(projectProperties)

pipeline {
    agent {
        dockerfile {
            filename 'Dockerfile'
            label 'jessie-amd64'
            dir 'docker'
            args '--privileged --sysctl net.ipv6.conf.lo.disable_ipv6=0 -e GOSU_UID=1006 -e GOSU_GID=1006'
        }
    }

    stages {
        stage('Submodule Init') {
            steps {
                sh '''
                    git submodule update --init --recursive --remote
                '''
            }
        }
        stage('Build Packages') {
            steps {
                sh '''
                    #!/bin/sh
                    scripts/build-submodules --verbose
                '''
            }
        }

        stage('Build ISO') {
            steps {
                sh '''
                    #!/bin/sh

                    # we do not want to fetch VyOS packages from the mirror,
                    # we rather prefer all build by ourself!
                    sed -i '/vyos_repo_entry/d' scripts/live-build-config

                    # Configure the ISO
                    ./configure --build-by="autobuild@vyos.net" --debian-mirror="http://ftp.us.debian.org/debian/"

                    # Debug to see which Debian packages we have so far
                    ls -al packages/*.deb

                    # Finally build our ISO
                    sudo make iso
                '''
            }
        }
    }

    post {
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
