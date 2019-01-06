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
            args '--privileged --sysctl net.ipv6.conf.lo.disable_ipv6=0'
        }
    }

    stages {
        stage('Submodule Init') {
            steps {
                sh '''
                    git submodule update --init --recursive
                    git submodule update --remote
                '''
            }
        }
        stage('Build Packages') {
            steps {
                sh 'scripts/build-submodules --verbose'
            }
        }
        stage('Build ISO') {
            steps {
                sh '''
                    #!/bin/sh
                    ./configure --build-by="autobuild@vyos.net" --debian-mirror="http://ftp.us.debian.org/debian/"
                    ls -al
                    ls -al packages
                    sudo make iso
                '''
            }
        }
    }

    post {
        always {
            echo 'One way or another, I have finished'
            // change build dir file permissions so wen can cleanup as regular
            // user (jenkins) afterwards
            sh 'sudo chmod -R 777 .'
            echo 'No cleanup for now ....'
            deleteDir() /* cleanup our workspace */
        }
    }
}
