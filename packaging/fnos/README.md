# Fanmili for fnOS

This directory contains the Docker Project package definition used to build
manually installable fnOS `.fpk` files. The packages contain metadata and a
Compose definition only; fnOS pulls the matching immutable Fanmili image from
GHCR during installation.

Build both fnOS platform packages from the repository root:

```bash
./packaging/fnos/build-fpk.sh 1.0.0
```

Artifacts are written to `dist/fnos/` and verified before the build succeeds.
The platform values use fnOS naming: `x86` for `linux/amd64` and `arm` for
`linux/arm64`.

The install wizard only asks for the Web UI port. Model API keys are configured
inside Fanmili after installation and are never embedded in the FPK.

The fnOS Compose definition starts the image entrypoint as root only long enough
to repair the bind-mounted data directory ownership. The entrypoint immediately
drops privileges, and the Next.js process runs as the image's `nextjs` user.
