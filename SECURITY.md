# Security Policy

## Our Commitment

Alternate Futures is committed to privacy, security, and censorship resistance. We take security vulnerabilities seriously and appreciate the security research community's efforts to responsibly disclose issues.

## Supported Versions

We currently support the following versions with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

### Preferred Method: Private Security Advisory

1. Go to the [Security tab](https://github.com/alternatefutures/alternatefutures-backend/security)
2. Click "Report a vulnerability"
3. Provide detailed information about the vulnerability

### Alternative Method: Email

If you prefer email, send details to: **security@alternatefutures.com**

Please include:

- Type of vulnerability (e.g., SQL injection, XSS, authentication bypass)
- Full paths of affected source file(s)
- Location of the affected code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact assessment and potential attack scenarios
- Any suggested fixes or mitigations

### What to Expect

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days with validation status
- **Fix Timeline**: Critical issues within 30 days, others within 90 days
- **Public Disclosure**: After patch is released and users have time to update (minimum 14 days)

### Responsible Disclosure Guidelines

We ask that you:

- Give us reasonable time to fix the vulnerability before public disclosure
- Make a good faith effort to avoid privacy violations, data destruction, or service interruption
- Do not exploit the vulnerability beyond what is necessary to demonstrate the issue
- Do not access, modify, or delete data belonging to others

### Recognition

We maintain a Security Hall of Fame for researchers who responsibly disclose vulnerabilities:

- Recognition in our CHANGELOG and release notes (if desired)
- Public acknowledgment on our website (if desired)
- Swag and credits for significant findings

## Security Best Practices for Deployers

If you're deploying Alternate Futures infrastructure:

### Required Security Measures

1. **Environment Variables**: Never commit `.env` files or expose secrets
   - Use strong, randomly generated JWT secrets
   - Rotate secrets regularly (minimum every 90 days)
   - Use different secrets for development, staging, and production

2. **Database Security**:
   - Use strong PostgreSQL passwords (minimum 32 characters)
   - Enable SSL/TLS for database connections
   - Regularly backup your database with encryption
   - Restrict database network access to application servers only

3. **API Security**:
   - Enable rate limiting on all public endpoints
   - Use Personal Access Tokens (PATs) with minimal required scopes
   - Regularly audit and revoke unused API keys
   - Monitor for unusual API usage patterns

4. **Infrastructure**:
   - Keep Docker images updated
   - Use non-root users (already configured in our Dockerfile)
   - Enable firewall rules to restrict unnecessary network access
   - Implement monitoring and alerting for security events

5. **SSL/TLS Certificates**:
   - Our platform auto-provisions Let's Encrypt certificates
   - Monitor certificate renewal jobs (runs daily at 2 AM)
   - Set up alerts for certificate expiration

### Security Headers

Our application implements security headers including:

- Strict-Transport-Security (HSTS)
- X-Content-Type-Options
- X-Frame-Options
- Content-Security-Policy

### Regular Security Maintenance

- Run `npm audit` regularly and fix vulnerabilities
- Update dependencies weekly (automated via Dependabot)
- Review access logs for suspicious activity
- Test disaster recovery procedures quarterly

## Security Features

### Built-in Security Features

1. **Authentication & Authorization**:
   - JWT-based authentication via dedicated auth service
   - Personal Access Token (PAT) system with rate limiting
   - Service-to-service authentication
   - Wallet-based authentication for Web3 users

2. **Input Validation**:
   - GraphQL schema validation
   - Route validation with URL sanitization
   - XSS prevention
   - SQL injection prevention via Prisma ORM

3. **Rate Limiting**:
   - PAT creation limited to 50/day per user
   - Maximum 500 active PATs per user
   - Redis-based rate limiting

4. **Audit Logging**:
   - All API key operations logged
   - Authentication events tracked
   - Permission changes recorded

5. **Secure Communications**:
   - Automatic SSL/TLS provisioning
   - HTTPS enforcement
   - Secure WebSocket connections (WSS)

### Privacy & Censorship Resistance

- **Decentralized Storage**: Support for IPFS, Arweave, Filecoin
- **Self-Hosted Options**: Full self-hosting capability
- **Web3 Domains**: Support for ENS, ArNS, IPNS
- **Minimal Data Collection**: Only essential data collected
- **Wallet-Based Auth**: Privacy-preserving authentication option

## Security Disclosure History

We maintain transparency about security issues and fixes:

| Date | Severity | Component | Status | CVE |
| ---- | -------- | --------- | ------ | --- |
| -    | -        | -         | -      | -   |

## Security Tooling

We use the following security tools:

- **CodeQL**: Automated code security scanning (weekly)
- **Dependabot**: Automated dependency vulnerability detection
- **npm audit**: Regular dependency security audits
- **TruffleHog**: Secrets scanning in CI/CD

## Compliance & Standards

We strive to comply with:

- OWASP Top 10 security best practices
- CIS Docker Benchmark security recommendations
- Web3 security best practices
- Privacy-by-design principles

## Additional Resources

- [PRIVACY.md](./PRIVACY.md) - Privacy policy and data practices
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guidelines
- [Documentation](./README.md) - General documentation

## Questions?

For general security questions or concerns that are not vulnerabilities, please open a GitHub Discussion or contact security@alternatefutures.com.

---

**Last Updated**: 2025-11-12
