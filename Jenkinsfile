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
        stage('Configure') {
            steps {
                sh './configure --build-by="autobuild@vyos.net" --debian-mirror="http://ftp.us.debian.org/debian/"'
            }
        }
        stage('Init Submodules') {
            environment {
                // there values are exportesd to all commands in this stage
                GIT_BRANCH_PACKAGE = "current"
                GIT_BRANCH_KERNEL  = "linux-vyos-4.19.y"
            }
            steps {
                parallel (
                    "mdns-repeater": {
                        sh '''
                            git submodule update --init packages/mdns-repeater
                            cd packages/mdns-repeater
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "pmacct": {
                        sh '''
                            git submodule update --init packages/pmacct
                            cd packages/pmacct
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "udp-broadcast-relay": {
                        sh '''
                            git submodule update --init packages/udp-broadcast-relay
                            cd packages/udp-broadcast-relay
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-bash": {
                        sh '''
                            git submodule update --init packages/vyatta-bash
                            cd packages/vyatta-bash
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-cfg": {
                        sh '''
                            git submodule update --init packages/vyatta-cfg
                            cd packages/vyatta-cfg
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-cfg-firewall": {
                        sh '''
                            git submodule update --init packages/vyatta-cfg-firewall
                            cd packages/vyatta-cfg-firewall
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-cfg-op-pppoe": {
                        sh '''
                            git submodule update --init packages/vyatta-cfg-op-pppoe
                            cd packages/vyatta-cfg-op-pppoe
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-cfg-qos": {
                        sh '''
                            git submodule update --init packages/vyatta-cfg-qos
                            cd packages/vyatta-cfg-qos
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-cfg-quagga": {
                        sh '''
                            git submodule update --init packages/vyatta-cfg-quagga
                            cd packages/vyatta-cfg-quagga
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-cfg-system": {
                        sh '''
                            git submodule update --init packages/vyatta-cfg-system
                            cd packages/vyatta-cfg-system
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyatta-cfg-vpn": {
                        sh '''
                            git submodule update --init packages/vyatta-cfg-vpn
                            cd packages/vyatta-cfg-vpn
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyos-kernel": {
                        sh '''
                            git submodule update --init packages/vyos-kernel
                            cd packages/vyos-kernel
                            git checkout $GIT_BRANCH_KERNEL
                        '''
                    },
                    "vyos-wireguard": {
                        sh '''
                            git submodule update --init packages/vyos-wireguard
                            cd packages/vyos-wireguard
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    },
                    "vyos-accel-ppp": {
                        sh '''
                            git submodule update --init packages/vyos-accel-ppp
                            cd packages/vyos-accel-ppp
                            git checkout $GIT_BRANCH_PACKAGE
                        '''
                    }
                )
            }
        }
        stage('Build Packages') {
            steps {
                sh 'git submodule update --remote'
                sh 'scripts/build-submodules'
            }
        }
        stage('Build ISO') {
            steps {
                sh 'ls -al'
                sh 'ls -al packages'
                sh 'sudo make iso'
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
