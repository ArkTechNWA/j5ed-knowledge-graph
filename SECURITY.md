# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Active  |
| < 1.0   | ❌ No      |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/ArkTechNWA/j5ed-knowledge-graph/security/advisories/new) to submit a report. This goes directly to the maintainer — not to the public issue tracker.

If private reporting is unavailable, email **security@arktechnwa.com** with:

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Impact assessment (what can an attacker do?)

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 1 week
- **Fix for critical/high**: targeted within 2 weeks
- **Credit**: reporters are credited in the release notes unless they prefer anonymity

This is a solo-maintained project. Timelines are honest estimates, not SLAs.

## What Qualifies

### Critical
- Authentication bypass (Bearer token validation failure)
- Tenant isolation breach (Agent A reads/writes Agent B's data)
- Path traversal via `MEMORY_FILE_PATH` or other env vars

### High
- Write safety failures (data loss under concurrency)
- Backup corruption or deletion
- Agent-scoped delete bypass (deleting entities you don't own)

### Medium
- Information disclosure in error messages or logs
- Observation injection that breaks provenance tagging
- Session fixation in HTTP/SSE transports

### Low
- Denial of service via crafted queries or large payloads
- Timing side-channels in search

## Out of Scope

- **stdio mode has no authentication** — this is by design. stdio is a local transport; the calling process is the trust boundary.
- **Large graph performance** — flat-file NDJSON storage has known scaling limits. This is a design tradeoff, not a vulnerability.
- **Dependency vulnerabilities with no exploit path** — if a transitive dep has a CVE but it's not reachable from this codebase, it's informational, not actionable.

## Security Design

The isolation model relies on `authored_by:<agentId>` observations as the tenancy boundary. Key assumptions:

1. Agents cannot forge their own `authored_by:` tags — the server injects provenance, and writes from agents that already include `authored_by:` are respected (trusted client model).
2. Bearer tokens in `AGENT_CREDENTIALS` are the authentication layer for HTTP/SSE. Token strength is the deployer's responsibility.
3. The NDJSON file is the persistence layer. File-system permissions are the deployer's responsibility.
4. No encryption at rest. If your graph contains secrets, protect the file at the OS level.
