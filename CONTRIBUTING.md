# Contributing to VyOS

You wan't to help us improve VyOS? This is awesome!

We accept any kind of Pull Requests on GitHub. In order to get your changes into
the main repository as smooth as possible please take yourself some time and
review this contribution guideline.

The following paragraphs are an excerpt from our Documentation.

## Submit a Patch

Patches are always more than welcome. To have a clean and easy to maintain
repository we have some guidelines when working with Git. A clean repository
eases the automatic generation of a changelog file.

A good approach for writing commit messages is actually to have a look at the
file(s) history by invoking git log path/to/file.txt.

### Prepare patch/commit

In a big system, such as VyOS, that is comprised of multiple components, it’s
impossible to keep track of all the changes and bugs/feature requests in one’s
head. We use a bugtracker known as Phabricator for it (“issue tracker” would
be a better term, but this one stuck).

The information is used in three ways:

* Keep track of the progress (what we have already done in this branch and
  what  we still need to do).
* Prepare automatic release notes for upcoming releases
* Help future maintainers of VyOS (it could be you!) to find out why certain
  things have been changed in the codebase or why certain features have been
  added
  
To make this approach work, every change must be associated with a task number
(prefixed with **T**) and a component. If there is no bug report/feature
request for the changes you are going to make, you have to create a Phabricator
task first. Once there is an entry in Phabricator, you should reference its id
in your commit message, as shown below:

* `ddclient: T1030: auto create runtime directories`
* `Jenkins: add current Git commit ID to build description`

If there is no [Phabricator](https://phabricator.vyos.net) reference in the
commits of your pull request, we have to ask you to amend the commit message.
Otherwise we will have to reject it.

## Writing good commit messages

The format should be and is inspired by this very good and detailed
[Git documentation](https://git-scm.com/book/ch5-2.html), it is also worth
reading https://chris.beams.io/posts/git-commit/.

This is nothing VyOS specific - it is more a general topic for distributed
development environments.

* A single, short, summary of the commit (recommended 50 characters or less,
  not exceeding 80 characters) containing a prefix of the changed component
  and the corresponding Phabricator reference e.g. `snmp: T1111:` or
  `ethernet: T2222:` - multiple components could be concatenated as in `snmp:
  ethernet: T3333`
* In some contexts, the first line is treated as the subject of an email and
  the rest of the text as the body. The blank line separating the summary from
  the body is critical (unless you omit the body entirely); tools like rebase
  can get confused if you run the two together.
* Followed by a message which describes all the details like:
  * What/why/how something has been changed, makes everyone’s life easier when
    working with `git bisect`
  * All text of the commit message should be wrapped at 72 characters if
    possible which makes reading commit logs easier with git log on a standard
	terminal (which happens to be 80x25)
  * If applicable a reference to a previous commit should be made linking those
    commits nicely when browsing the history: `After commit abcd12ef ("snmp:
	this is a headline") a Python import statement is missing, throwing the
	following exception: ABCDEF`
* Always use the `-x` option to the `git cherry-pick` command when back or
  forward porting an individual commit. This automatically appends the line:
  `(cherry picked from commit <ID>)` to the original authors commit message
  making it easier when bisecting problems.
* Every change set must be consistent (self containing)! Do not fix multiple
  bugs in a single commit. If you already worked on multiple fixes in the same
  file use git add –patch to only add the parts related to the one issue into
  your upcoming commit.
  
## Bug Report/Issue
Issues or bugs are found in any software project. VyOS is not an exception.

All issues should be reported to the developers. This lets the developers know
what is not working properly. Without this sort of feedback every developer
will believe that everything is working correctly.

### I have found a bug, what should I do?

When you believe you have found a bug, it is always a good idea to verify the
issue prior to opening a bug request.

* Consult our [Documentation](https://docs.vyos.io) to ensure that you have
  configured your system correctly
* Get community support via [Slack](https://slack.vyos.io) or our online
  [Forum](https://forum.vyos.io)

#### Ensure the problem is reproducible

When you are able to verify that it is actually a bug, spend some time to
document how to reproduce the issue. This documentation can be invaluable.

When you wish to have a developer fix a bug that you found, helping them
reproduce the issue is beneficial to everyone. Be sure to include information
about the hardware you are using, commands that you were running, any other
activities that you may have been doing at the time. This additional
information can be very useful.

* What were you attempting to achieve?
* What was the configuration prior to the change?
* What commands did you use? Use e.g. ``show configuration commands``

#### Include output

The output you get when you find a bug can provide lots of information. If you
get an error message on the screen, copy it exactly. Having the exact message
can provide detail that the developers can use. Like wise if you have any log
messages that also are from the time of the issue, include those. They may
also contain information that is helpful for the development team.

### Reporting

In order to open up a bug-report/feature request you need to create yourself
an account on [Phabricator](https://phabricator.vyos.net). On the left
side of the specific project (VyOS 1.2 or VyOS 1.3) you will find quick-links
for opening a bug-report/feature request.

* Provide as much information as you can
* Which version of VyOS are you using? Use operational level command:
  ``show version``
* How can we reproduce this Bug? Please include a CLI configuration, you can
  use ``show configuration command | strip-private`` to remove sensitive
  information before publishing.

## Feature Request

You have an idea of how to make VyOS better or you are in need of a specific
feature which all users of VyOS would benefit from? To send a feature request
please search [Phabricator](https://phabricator.vyos.net) if there is already a
request pending. You can enhance it or if you don't find one, create a new one
by use the quick link in the left side under the specific project.

## Code Contribution

For contributing code to VyOS please take a short moment and review the guideline
outlined in our Documentation at
https://docs.vyos.io/en/latest/contributing/development.html#submit-a-patch

### Coding Guidelines

We have some small coding guidelines which are defined in a separate section of
at https://docs.vyos.io/en/latest/contributing/development.html#coding-guidelines.
The guidelines cover how to create the necessary XML structure for new features
and also how to read in the code from the CLI into the Python based scripting
backend.

Thank you for taking the time reading this guide.

It might also worth browsing our [Blog](https://blog.vyos.io) for additional
info and updates.
