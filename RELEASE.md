# Releasing Device OS Flashing Utility

1. Make sure you have the latest `master` branch:
  * `git checkout master`
  * `git pull`
2. Bump the package version:
  * `npm version <major|minor|patch>`
3. Push the changes and the release tag:
  * `git push origin master --follow-tags`
4. CI will publish the package to npmjs.org.
