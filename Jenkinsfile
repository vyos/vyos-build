#!/usr/bin/env groovy
// Copyright (C) 2019-2021 VyOS maintainers and contributors
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

// Using a version specifier library, use 'current' branch. The underscore (_)
// is not a typo! You need this underscore if the line immediately after the
// @Library annotation is not an import statement!
@Library('vyos-build@current')_
setDescription()

node('Docker') {
    stage('Setup Container') {
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
            env.DOCKER_ARGS = '--privileged --sysctl net.ipv6.conf.lo.disable_ipv6=0 -e GOSU_UID=' + env.USR_ID + ' -e GOSU_GID=' + env.GRP_ID
            env.BASE_VERSION = '1.5-rolling-'
        }
    }
}

pipeline {
    agent {
        docker {
            label "Docker"
            args "${env.DOCKER_ARGS}"
            image "${env.DOCKER_IMAGE}"
            alwaysPull true
            reuseNode true
        }
    }
    parameters {
        string(name: 'BUILD_BY', defaultValue: 'autobuild@vyos.net', description: 'Builder identifier (e.g. jrandomhacker@example.net)')
        string(name: 'BUILD_VERSION', defaultValue: env.BASE_VERSION + 'ISO8601-TIMESTAMP', description: 'Version number (release builds only)')
        booleanParam(name: 'BUILD_PUBLISH', defaultValue: false, description: 'Publish this build AWS S3')
        booleanParam(name: 'BUILD_SNAPSHOT', defaultValue: false, description: 'Upload image to AWS S3 snapshot bucket')
        booleanParam(name: 'TEST_SMOKETESTS', defaultValue: true, description: 'Run Smoketests after ISO build')
        booleanParam(name: 'TEST_RAID1', defaultValue: true, description: 'Perform RAID1 installation tests')
    }
    options {
        disableConcurrentBuilds()
        timeout(time: 240, unit: 'MINUTES')
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }
    stages {
        stage('Build ISO') {
            when {
                beforeOptions true
                beforeAgent true
                // Only run ISO image build process of explicit user request or
                // once a night triggered by the timer.
                anyOf {
                    triggeredBy 'TimerTrigger'
                    triggeredBy cause: "UserIdCause"
                }
            }
            environment {
                PYTHONDONTWRITEBYTECODE = 1
            }
            steps {
                script {
                    // Display Git commit Id used with the Jenkinsfile on the Job "Build History" pane
                    def commitId = sh(returnStdout: true, script: 'git rev-parse --short=11 HEAD').trim()
                    currentBuild.description = sprintf('Git SHA1: %s', commitId[-11..-1])

                    def CUSTOM_PACKAGES = ''
                    if (params.TEST_SMOKETESTS)
                        CUSTOM_PACKAGES = '--custom-package vyos-1x-smoketest'

                    def VYOS_VERSION = params.BUILD_VERSION
                    if (params.BUILD_VERSION == env.BASE_VERSION + 'ISO8601-TIMESTAMP')
                        VYOS_VERSION = env.BASE_VERSION + sh(returnStdout: true, script: 'date -u +%Y%m%d%H%M').toString().trim()

                    sh """
                        sudo --preserve-env ./build-vyos-image \
                            --build-by "${params.BUILD_BY}" \
                            --debian-mirror http://deb.debian.org/debian/ \
                            --build-type release \
                            --version "${VYOS_VERSION}" ${CUSTOM_PACKAGES} generic
                    """

                    if (fileExists('build/live-image-amd64.hybrid.iso') == false) {
                        error('ISO build error')
                    }
                }
            }
        }
        stage('Smoketests for RAID-1 system installation') {
            when {
                expression { fileExists 'build/live-image-amd64.hybrid.iso' }
                expression { return params.TEST_RAID1 }
            }
            steps {
                sh "sudo make testraid"
            }
        }
        stage('Smoketests for TPM config encryption') {
            when {
                expression { fileExists 'build/live-image-amd64.hybrid.iso' }
            }
            steps {
                sh "sudo make testtpm"
            }
        }
        stage('Smoketests') {
            when {
                expression { return params.TEST_SMOKETESTS }
            }
            parallel {
                stage('CLI validation') {
                    when {
                        expression { fileExists 'build/live-image-amd64.hybrid.iso' }
                    }
                    steps {
                        sh "sudo make test"
                    }
                }
                stage('vyos-configd and arbitrary config loader') {
                    when {
                        expression { fileExists 'build/live-image-amd64.hybrid.iso' }
                    }
                    steps {
                        sh "sudo make testc"
                    }
                }
            }
        }
    }
    post {
        success {
            script {
                // only deploy ISO if build from official repository
                if (isCustomBuild())
                    return

                // always store local artifacts
                archiveArtifacts artifacts: '**/build/vyos-*.iso, **/build/vyos-*.qcow2',
                    allowEmptyArchive: true

                // only deploy ISO if requested via parameter
                if (!params.BUILD_PUBLISH)
                    return

                files = findFiles(glob: 'build/vyos*.iso')
                // Publish ISO image to daily builds bucket
                if (files) {
                    // Publish ISO image to snapshot bucket
                    if (files && params.BUILD_SNAPSHOT) {
                        withAWS(region: 'us-east-1', credentials: 's3-vyos-downloads-rolling-rw') {
                            s3Upload(bucket: 's3-us.vyos.io', path: 'snapshot/' + params.BUILD_VERSION + '/', workingDir: 'build', includePathPattern: 'vyos*.iso',
                            cacheControl: "public, max-age=2592000")
                        }
                    } else {
                        // Publish build result to AWS S3 rolling bucket
                        withAWS(region: 'us-east-1', credentials: 's3-vyos-downloads-rolling-rw') {
                            s3Upload(bucket: 's3-us.vyos.io', path: 'rolling/' + getGitBranchName() + '/',
                                     workingDir: 'build', includePathPattern: 'vyos*.iso')
                            s3Copy(fromBucket: 's3-us.vyos.io', fromPath: 'rolling/' + getGitBranchName() + '/' + files[0].name,
                                   toBucket: 's3-us.vyos.io', toPath: 'rolling/' + getGitBranchName() + '/vyos-rolling-latest.iso')
                        }
                    }

                    // Trigger GitHub action which will re-build the static community website which
                    // also holds the AWS download links to the generated ISO images
                    withCredentials([string(credentialsId: 'vyos.net-build-trigger-token', variable: 'TOKEN')]) {
                        sh '''
                            curl -X POST --header "Accept: application/vnd.github.v3+json" \
                            --header "authorization: Bearer $TOKEN" --data '{"ref": "production"}' \
                            https://api.github.com/repos/vyos/community.vyos.net/actions/workflows/main.yml/dispatches
                        '''
                    }
                }

                // Publish ISO image to snapshot bucket
                if (files && params.BUILD_SNAPSHOT) {
                    withAWS(region: 'us-east-1', credentials: 's3-vyos-downloads-rolling-rw') {
                        s3Upload(bucket: 's3-us.vyos.io', path: 'snapshot/',
                                 workingDir: 'build', includePathPattern: 'vyos*.iso')
                    }
                }
            }
        }
        failure {
            archiveArtifacts artifacts: '**/build/vyos-*.iso, **/build/vyos-*.qcow2',
                allowEmptyArchive: true
        }
        cleanup {
            echo 'One way or another, I have finished'
            // the 'build' directory got elevated permissions during the build
            // cdjust permissions so it can be cleaned up by the regular user
            sh 'sudo make purge'
            deleteDir() /* cleanup our workspace */
        }
    }
}
