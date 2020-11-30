# Contributing to VyOS

You wan't to help us improve VyOS? This is awesome!

We accept any kind of Pull Requests on GitHub. In order to get your changes into
the main repository as smooth as possible please take yourself some time and
review this contribution guideline.

The following paragraphs are an excerpt from our Documentation.

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
