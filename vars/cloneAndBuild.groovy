#!/usr/bin/env groovy
// Copyright (C) 2021 VyOS maintainers and contributors
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

def call(description, architecture, pkgList, buildCmd) {
    // package build must be done in "any" subdir. Without it the Debian build system
    // is unable to generate the *.deb files in the sources parent directory, which
    // will cause a "Permission denied" error.
    dir ("build-${architecture}") {
        // cleanup
        deleteDir()

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
                if (pkg.scmUrl && pkg.scmCommit) {
                    dir(getJenkinsfilePath() + pkg.name) {
                        checkout([$class: 'GitSCM',
                            doGenerateSubmoduleConfigurations: false,
                            extensions: [[$class: 'CleanCheckout']],
                            branches: [[name: pkg.scmCommit]],
                            userRemoteConfigs: [[url: pkg.scmUrl]]])
                    }
                }
            }
        }

        // compile the source(s) ...
        if (pkgList) {
            pkgList.each { pkg ->
                dir(getJenkinsfilePath() + pkg.name) {
                    sh pkg.buildCmd
                }
            }
        } else if (buildCmd) {
            sh buildCmd
        } else {
            sh 'dpkg-buildpackage -uc -us -tc -b'
        }
    }
    if (architecture == 'amd64') {
        archiveArtifacts artifacts: "**/*.deb", fingerprint: true
    } else {
        archiveArtifacts artifacts: "**/*_${architecture}.deb", fingerprint: true
    }
}
