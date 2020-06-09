# Device OS Flashing Utility

device-os-flash is a tool that simplifies flashing of Particle devices. It can flash official Device OS releases, as well as user-provided module binaries – via DFU or a debugger.

## Current Status

**This tool is experimental. Use it at your own risk.**

## Installation

Install with npm globally:

```sh
npm install --global @particle/device-os-flash
```

**Prerequisites:**

- [OpenOCD](http://openocd.org). It is recommended to use the version of OpenOCD that is bundled with [Workbench](https://www.particle.io/workbench).
- [dfu-util](http://dfu-util.sourceforge.net). Installing the latest version available via your package manager should be sufficient.
- Node.js 12 or higher.

**Supported Debuggers:**

- [Particle Debugger](https://store.particle.io/products/particle-debugger).
- [ST-LINK/V2](https://www.st.com/en/development-tools/st-link-v2.html).

## Getting Started

The examples below cover most of the use case scenarios. For the full list of available options, see the tool's help:

```sh
device-os-flash -h
```

**Flashing all detected devices with Device OS 1.5.0 via DFU:**

```sh
device-os-flash --all-devices 1.5.0
```

device-os-flash automatically downloads release binaries from GitHub. If you are experiencing rate limiting errors, set your GitHub [access token](https://help.github.com/en/github/authenticating-to-github/creating-a-personal-access-token-for-the-command-line) via the `GITHUB_TOKEN` environment variable.

**Same as above, but do not flash [Tinker](https://github.com/particle-iot/device-os/tree/develop/user/applications/tinker):**

```sh
device-os-flash --all-devices --no-user 1.5.0
```

**Flashing a user application to all detected devices:**

```sh
device-os-flash --all-devices my_app.bin
```

**Flashing specific devices:**

```sh
device-os-flash -d my_boron -d my_electon 1.5.0
```

Resolving device names requires a valid Particle API token. If you are signed in via the Particle CLI, device-os-test will use the CLI's token. Alternatively, the token can be specified via the `PARTICLE_TOKEN` environment variable.

**Flashing all detected devices via OpenOCD:**

```sh
device-os-flash --all-devices --openocd 1.5.0
```
