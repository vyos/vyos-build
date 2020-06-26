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

def call(text = null) {
    def item = Jenkins.instance.getItemByFullName(env.JOB_NAME)

    // build up the main description text
    def description = ""
    if (text) {
        description += "<h2>VyOS package build: " + text + "</h2>"
    } else {
        description += "<h2>VyOS package build: " + getGitRepoName().replace('.git', '') + "</h2>"
    }

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

