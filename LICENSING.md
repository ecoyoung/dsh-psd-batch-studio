# Licensing

Copyright (c) 2026 上海缙嘉科技有限公司 (Genca). Open-sourced by the VinkWork
team. VinkWork's core product is [VinkClaw.com](https://vinkclaw.com).

`dsh-psd-batch-studio` is released under a **modified version of the Apache
License 2.0**, following the same structure as Dify's license: commercial use is
allowed, with additional conditions for multi-tenant services and branding.

The exact terms are in [LICENSE](LICENSE); the unmodified Apache License 2.0 text
is in [LICENSE-APACHE](LICENSE-APACHE).

## What is allowed for free

- Commercial use, including internal enterprise use.
- Use as a backend service for other applications, or as an application
  development platform for enterprises.
- Modification and redistribution, provided the Apache 2.0 notices and the
  additional conditions are kept.
- Personal, educational, research, and government use.

## When a commercial license is required

A separate written commercial license from 上海缙嘉科技有限公司 (Genca) is
required to:

1. **Operate a multi-tenant service** — using the source code to serve multiple
   customer organizations or workspaces from one deployment, unless explicitly
   authorized in writing. One tenant corresponds to one customer organization or
   workspace.
2. **Remove or modify the logo or copyright information** in the plugin's
   frontend (the UI under `src/client/`, the built `client.js`, `icon.svg`, and
   the display strings under `locale/`).

For commercial licensing, open an issue at
<https://github.com/vinkwork/dsh-psd-batch-studio/issues> or contact the
maintainers through the repository.

## Contributions

By contributing code, you agree that:

1. The producer may adjust the open-source agreement to be stricter or more
   relaxed as deemed necessary.
2. Your contributed code may be used for commercial purposes, including but not
   limited to cloud business operations.

This mirrors the contributor terms used by Dify and keeps the project able to
offer both the community and commercial editions.

## Version history

- **v0.2.0 and later:** modified Apache License 2.0 (this document).
- **v0.1.2 and earlier:** PolyForm Noncommercial License 1.0.0. Those released
  versions remain under the terms they were published with; the change applies
  from v0.2.0 onward.

## Third-party components

The bundled build artifacts include MIT-licensed third-party code. See
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
