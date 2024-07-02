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

def call() {
    // Returns true if this is a custom build launched on any project fork.
    // Returns false if this is build from git@github.com:vyos/<reponame>.
    // <reponame> can be e.g. vyos-1x.git
    // GitHub organisation base URL
    def gitURI = 'git@github.com:vyos/' + getGitRepoName()
    def httpURI = 'https://github.com/vyos/' + getGitRepoName()

    return !((getGitRepoURL() == gitURI) || (getGitRepoURL() == httpURI)) || isPullRequest()
}
