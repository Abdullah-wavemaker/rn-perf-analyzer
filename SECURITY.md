# Security model

RN Performance Analyzer is a local developer tool. It drives connected Android
devices (install, launch, input) and processes untrusted input: uploaded APKs,
device output and data reported by apps. This document describes what it
protects against and how.

## Assets and threats

| Asset | Threat |
| --- | --- |
| Control over connected devices (install, uninstall, input) | Other local processes or users; malicious web pages in the developer's browser (CSRF, DNS rebinding) |
| Uploaded APKs and recordings | Other local users; exfiltration through the API |
| The host machine | Command injection through adb; path traversal or zip bombs in APKs; parser exploits (XML, binary manifest); resource exhaustion from a hostile app |
| Secrets in app traffic (tokens in URLs) | Leaking into recordings, exports and reports |

## Controls

### Network exposure
- The API listens on **127.0.0.1 only**. Non-loopback hosts are refused at startup, with no override.
- The optional HTTP ingest endpoint for device agents (`--ingest-port`) is a **separate listener** with its own token. It accepts only agent batches and cannot reach the API. `adb reverse` is set up only while recording, and only when ingest is enabled.

### Authentication
- A random 256-bit **launch token** is generated per run and printed once in the terminal. `RNPA_TOKEN` can pin it for scripting (32–128 URL-safe characters).
- `GET /auth?token=` exchanges it for a random **session cookie** (`HttpOnly`, `SameSite=Strict`, path `/`), then redirects so the token leaves the address bar.
- Scripts may send `Authorization: Bearer <launch token>` instead.
- All secret comparisons are constant-time.

### Browser-borne attacks
- **DNS rebinding**: requests whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` are rejected.
- **CSRF**: `POST`/`PUT`/`DELETE` require the `X-RNPA-Request: 1` header, which forces a CORS preflight that the server never approves. A foreign `Origin` is rejected outright, and CORS is not supported at all.
- **Headers**: a strict CSP on every response (`default-src 'self'`; no inline scripts or styles; `frame-ancestors 'none'`), plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP and a restrictive `Permissions-Policy`. API responses are `no-store`.
- **Dashboard**: never uses `innerHTML`; every app-derived string (URLs, screen and component names, error messages) is rendered as text.
- **HTML report**: built server-side with every value HTML-escaped, and served with a CSP that forbids scripts entirely.

### Command execution
- External programs run through a single wrapper (`apps/server/src/exec.ts`) with `shell: false`, argument arrays, timeouts, abort signals and output caps.
- `adb shell` joins its arguments into a device-side shell command. Every interpolated value (package names, components, serials, pids, coordinates, key codes, ports) passes a strict allow-list validator (`android/validate.ts`) before it gets there. Nothing is escaped ad hoc.
- The signing keystore password reaches `keytool` and `apksigner` through environment variables, never through argv (which other users could see in process listings).

### Untrusted input
- **Uploads**: streamed to disk under a random name, size-capped (1 GB by default, `RNPA_MAX_APK_MB`), SHA-256 hashed, and checked for ZIP magic. The file is parsed before it is stored, and the client-supplied name is sanitized and used for display only.
- **ZIP handling**: `yauzl` runs with strict file names and size validation. Entries are never extracted to paths taken from the archive. Reads are capped (8 MB manifest, 256 MB bundle). Encrypted entries and > 200k entries are rejected.
- **Binary manifest parser**: bounds-checks every offset, requires each chunk to make progress, and caps elements and strings.
- **UI hierarchy XML**: documents with `DOCTYPE`/`ENTITY` declarations are rejected, and node count is capped.
- **Agent data**: validated with zod (type allow-list, ID formats, 16 KB metadata, 500 events per batch, 512 KB per batch, 2M events per session). Logcat lines are accepted only from processes that belong to the session's package (checked via `/proc/<pid>/cmdline`). Chunk reassembly is bounded in count, size and age.
- **CPU profiles**: schema-validated, with a 64 MB body limit.
- **Metro / CDP**: the inspector URL must be on loopback, and debugger URLs returned by Metro must also be on loopback.

### Privacy
- The agent records **metadata only**: method, URL, status, sizes and timings. It never reads request or response bodies or headers.
- URLs are redacted **on the device** and again on the host: credentials and fragments are removed, and sensitive query parameters (`token`, `key`, `password`, `session`, `sig`, `code`, `email`, …) are replaced with `[redacted]`. Length is capped.

### Data at rest
- `~/.rnpa` and its subdirectories are created with mode `0700`; the database, APKs, builds and keystore files with `0600`.
- Instrumented APKs are signed with a **local test key** generated per installation. They must not be distributed.

## Out of scope

- A malicious process running as the same OS user. It can read `~/.rnpa` and the terminal output directly.
- A compromised device or emulator. Its output is treated as untrusted data, but its own integrity is not verified.

## Reporting

Please report vulnerabilities privately to the maintainers rather than in a public issue.
