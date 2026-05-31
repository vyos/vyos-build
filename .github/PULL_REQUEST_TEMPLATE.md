<!-- All PR should follow this template to allow a clean and transparent review -->
<!-- Text placed between these delimiters is considered a comment and is not rendered -->

## Change summary
<!--- Provide a general summary of your changes in the Title above -->

## Types of changes
<!---
What types of changes does your code introduce? Put an 'x' in all the boxes that apply.
NOTE: Markdown requires no leading or trailing whitespace inside the [ ] for checking
the box, please use [x]
-->
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Code style update (formatting, renaming)
- [ ] Refactoring (no functional changes)
- [ ] Migration from an old Vyatta component to vyos-1x, please link to related PR inside obsoleted component
- [ ] Other (please describe):

## Related Task(s)
<!-- optional: Link to related other tasks on Phabricator. -->
<!-- * https://vyos.dev/Txxxx -->

## Related PR(s)
<!-- Link here any PRs in other repositories that are required by this PR -->

## How to test / Smoketest result
<!---
Please describe in detail how you tested your changes. Include details of your testing
environment, and the tests you ran. When pasting configs, logs, shell output, backtraces,
and other large chunks of text, surround this text with triple backtics
```
like this
```

Or provide the output of the smoketest

```
$ /usr/libexec/vyos/tests/smoke/cli/test_xxx_feature.py
test_01_simple_options (__main__.TestFeature.test_01_simple_options) ... ok
```
-->

## Checklist:
<!--- Go over all the following points, and put an `x` in all the boxes that apply. -->
<!--- If you're unsure about any of these, don't hesitate to ask. We're here to help! -->
<!--- The entire development process is outlined here: https://docs.vyos.io/en/latest/contributing/development.html -->
- [ ] I have read the [**CONTRIBUTING**](https://github.com/vyos/vyos-1x/blob/rolling/CONTRIBUTING.md) document
- [ ] I have linked this PR to one or more Phabricator Task(s)
- [ ] My commit headlines contain a valid Task id
- [ ] My change requires a change to the documentation
- [ ] I have updated the documentation accordingly
