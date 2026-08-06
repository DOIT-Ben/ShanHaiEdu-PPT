# PPT-Agent development ownership

The source repository at `/srv/codex-workspace/PPT-Agent` is a shared
`root:codex-dev` development tree. Its directory ACLs and setgid bit make Git
metadata and build output group-writable without granting either world-write
permissions or general host administration.

## Invariants

- The repository root, `.git`, `.git/objects`, and `.git/refs` are
  `root:codex-dev`, setgid, and carry a default group-rwx ACL.
- `core.sharedRepository=group` is set in the repository. Developer commands
  use `scripts/with-dev-umask.sh`, which starts them with `umask 0002`.
- `codex-dev` has an exact Git `safe.directory` entry for this root-owned
  working tree. This is not a wildcard trust exception.
- `bun run check:ownership` fails when root-private Git metadata or `dist`
  artifacts would block `codex-dev`. Immutable Git object files require group
  read access; their setgid object directories carry the group write access
  needed to create new objects.
- `bun run verify:ownership` is the root-only integration check. It runs Git
  status, ownership verification, tests, type checking, and build as both
  root and `codex-dev`.
- The running service remains a separate low-privilege account:
  `ppt-agent:ppt-agent` with `UMask=0077`. Development sharing never changes
  the service account or its private data paths.

## Controlled root entry

The installed `/usr/local/libexec/ppt-agent-admin` is root-owned and not
writable by `codex-dev`. `/etc/sudoers.d/ppt-agent-codex-dev` allows only its
following actions:

| Action | Scope |
| --- | --- |
| `repair-dev-ownership` | PPT-Agent source, Git metadata, and `dist` sharing metadata |
| `check-dev-ownership` | Read-only ownership summary |
| `prepare-test-candidate <name>` | A validated directory below `/opt/ppt-agent-test/candidates` |
| `prepare-evaluation-reports` | Only the quick-deck report directory; grants `codex-dev` traversal to its parents, never other service data |
| `service-status <allowlisted-unit>` | Read-only state for PPT-Agent service units |
| `restart-test-service` | Only `ppt-agent-test.service` |

The entry never executes repository code as root, accepts no arbitrary path,
shell, package-manager, or generic `systemctl` operation, and does not grant
`codex-dev` ordinary sudo. Candidate names are restricted to a single
alphanumeric, dot, underscore, or hyphen segment.

## Recovery

If the doctor reports a root-private Git file, run the allowlisted repair and
then re-run the doctor:

```bash
sudo -n /usr/local/libexec/ppt-agent-admin repair-dev-ownership
bun run check:ownership
```

System-side permission changes must be backed up under
`/opt/backups/ppt-agent/<timestamp>-v4-permissions` before they are changed.
Do not use `chmod 777`, recursive host-wide ownership changes, or a general
sudo rule as a replacement for this boundary.
