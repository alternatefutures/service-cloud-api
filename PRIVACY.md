# Privacy Policy

**Last Updated**: 2025-11-12

## Our Privacy Commitment

Alternate Futures is built on the principles of **privacy, decentralization, and censorship resistance**. We believe in giving users control over their data and minimizing data collection to only what is essential for service operation.

This document describes how the Alternate Futures Service Cloud API handles user data.

## Core Privacy Principles

1. **Data Minimization**: We only collect data that is absolutely necessary for service operation
2. **User Control**: Users own their data and can export or delete it at any time
3. **Decentralization First**: Support for decentralized storage and Web3 authentication
4. **Transparency**: Clear documentation of all data practices
5. **Privacy by Design**: Privacy considerations are built into every feature
6. **No Tracking**: We do not use analytics for tracking user behavior
7. **Open Source**: All code is open source and auditable

## Data We Collect

### Account Information

When you create an account, we collect:

- **Email address** (optional, only if not using wallet-based auth)
- **Wallet address** (for Web3 authentication)
- **Username** (chosen by you)
- **Password hash** (bcrypt, never stored in plain text)
- **Account creation timestamp**

**Purpose**: Authentication and account management
**Legal Basis**: Contractual necessity
**Retention**: Until account deletion

### Project & Deployment Data

When you use our service, we store:

- **Project names and descriptions**
- **Deployment configurations**
- **Environment variables** (encrypted at rest)
- **Custom domain names**
- **SSL/TLS certificates** (Let's Encrypt)
- **Function code and build outputs**

**Purpose**: Service delivery, deployment management
**Legal Basis**: Contractual necessity
**Retention**: Until project deletion or account termination

### Usage & Billing Data

For billing and service optimization:

- **API request counts** (aggregated, buffered via Redis)
- **Storage usage metrics**
- **Bandwidth consumption**
- **Subscription status**
- **Payment information** (processed by Stripe, not stored by us)
- **Invoice records**

**Purpose**: Billing, usage metering, service optimization
**Legal Basis**: Contractual necessity
**Retention**: 7 years for tax compliance (invoices), 90 days (usage metrics)

### Authentication Logs

For security purposes:

- **Personal Access Token (PAT) creation/usage logs**
- **Authentication events** (login timestamps, IP addresses)
- **API key operations** (creation, revocation, usage)

**Purpose**: Security, fraud prevention, audit trail
**Legal Basis**: Legitimate interest (security)
**Retention**: 90 days

### Chat & Communication Data

If you use our chat features:

- **Chat messages**
- **Agent interactions**
- **Conversation metadata**

**Purpose**: Feature delivery, support
**Legal Basis**: Contractual necessity
**Retention**: Until conversation deletion

## Data We Do NOT Collect

We explicitly do NOT collect:

- Browsing history or website analytics
- Device fingerprints
- Location data (beyond IP-based geolocation for security)
- Social media profiles
- Third-party tracking cookies
- Personal data from deployed applications (your functions are isolated)

## How We Use Your Data

We use collected data exclusively for:

1. **Service Delivery**: Deploying and hosting your functions
2. **Authentication**: Verifying your identity and managing access
3. **Billing**: Calculating usage and processing payments
4. **Security**: Protecting against unauthorized access and abuse
5. **Support**: Responding to your support requests
6. **Legal Compliance**: Meeting regulatory obligations

We do NOT use your data for:

- Marketing or advertising
- Selling to third parties
- Training AI models (unless you explicitly opt in)
- Profiling or behavioral analysis

## Data Storage & Security

### Storage Locations

- **Primary Database**: PostgreSQL (self-hosted or managed)
- **Cache/Queue**: Redis (self-hosted or managed)
- **File Storage**: Choose from:
  - **IPFS** (decentralized, content-addressed)
  - **Arweave** (permanent decentralized storage)
  - **Filecoin** (decentralized storage network)
  - **Self-hosted IPFS** (full control)

### Security Measures

- **Encryption in Transit**: All data transmitted via HTTPS/TLS 1.3
- **Encryption at Rest**: Database encryption available (deployment-dependent)
- **Password Security**: bcrypt hashing with salt
- **Secret Management**: Environment variables encrypted
- **Access Control**: Role-based permissions, JWT authentication
- **Audit Logging**: All sensitive operations logged
- **Regular Security Audits**: CodeQL scanning, dependency audits

### Data Location

Alternate Futures can be deployed:

- **On decentralized infrastructure** (Akash Network)
- **Self-hosted** (full control over data location)
- **Traditional cloud** (Railway, AWS, etc.)

For our hosted service (if applicable):

- Data center location: [SPECIFY BASED ON DEPLOYMENT]
- Subject to laws of: [SPECIFY JURISDICTION]

## Third-Party Services

We use the following third-party services that may process your data:

### Payment Processing

- **Stripe**: Payment processing, PCI-compliant
  - Data shared: Email, payment information
  - Privacy policy: https://stripe.com/privacy
  - Purpose: Billing and subscription management

### Decentralized Storage (Optional)

- **IPFS**: Decentralized file storage
  - Data shared: Publicly accessible files you choose to publish
  - No personal data collection

- **Arweave**: Permanent decentralized storage
  - Data shared: Publicly accessible files you choose to publish
  - Note: Data on Arweave is permanent and cannot be deleted

- **Filecoin**: Decentralized storage network
  - Data shared: Files you choose to store
  - Privacy policy: https://filecoin.io/privacy-policy/

### Error Monitoring (Optional)

- **Sentry**: Error tracking and monitoring
  - Data shared: Error logs, stack traces (no personal data)
  - Privacy policy: https://sentry.io/privacy/
  - Can be disabled or self-hosted

### Domain Services

- **Let's Encrypt**: SSL/TLS certificate issuance
  - Data shared: Domain names
  - Privacy policy: https://letsencrypt.org/privacy/

## Web3 & Blockchain Data

If you use Web3 features:

- **Wallet addresses** are stored but not linked to real-world identity
- **Blockchain transactions** are public and permanent by design
- **ENS, ArNS, IPNS domains** may reveal wallet associations
- **On-chain data** cannot be deleted (inherent to blockchain)

## Cookies & Tracking

We use minimal cookies:

- **Session cookies**: For authentication (essential, no consent required)
- **JWT tokens**: For API authentication
- **No tracking cookies**: We do not use analytics or advertising cookies

## Your Privacy Rights

### Access & Export

You can request a copy of all your data:

```graphql
query {
  me {
    dataExport
  }
}
```

### Deletion (Right to be Forgotten)

Delete your account and all associated data:

```graphql
mutation {
  deleteAccount(confirmEmail: "your@email.com") {
    success
  }
}
```

**Note**: Data stored on blockchain or permanent storage (Arweave) cannot be deleted.

### Correction

Update your information anytime via the API:

```graphql
mutation {
  updateUser(email: "new@email.com") {
    user {
      email
    }
  }
}
```

### Data Portability

Export your data in machine-readable format (JSON) at any time.

### Withdraw Consent

- Delete your account to withdraw all consent
- Revoke API keys and PATs individually
- Disconnect wallet authentication

### Object to Processing

Contact privacy@alternatefutures.com to object to specific data processing activities.

## Data Retention

| Data Type           | Retention Period          |
| ------------------- | ------------------------- |
| Account data        | Until account deletion    |
| Project data        | Until project deletion    |
| Usage metrics       | 90 days                   |
| Authentication logs | 90 days                   |
| Invoices            | 7 years (tax requirement) |
| Error logs          | 30 days                   |
| Blockchain data     | Permanent (immutable)     |
| Arweave data        | Permanent (by design)     |

## Children's Privacy

Alternate Futures is not intended for users under 13 years of age. We do not knowingly collect data from children. If you believe a child has provided us with personal data, contact privacy@alternatefutures.com.

## GDPR Compliance (EU Users)

For users in the European Union:

- **Legal Basis**: Contractual necessity, legitimate interest, consent (where applicable)
- **Data Controller**: Alternate Futures
- **Data Protection Officer**: privacy@alternatefutures.com
- **EU Representative**: [SPECIFY IF APPLICABLE]
- **Supervisory Authority**: [SPECIFY BASED ON LOCATION]

Your GDPR rights:

- Right to access
- Right to rectification
- Right to erasure ("right to be forgotten")
- Right to restrict processing
- Right to data portability
- Right to object
- Right to withdraw consent
- Right to lodge a complaint with supervisory authority

## CCPA Compliance (California Users)

For California residents:

- **Categories of Personal Information**: As listed in "Data We Collect"
- **Business Purpose**: Service delivery, as described above
- **Selling Personal Information**: We do NOT sell personal information
- **Sharing Personal Information**: Only with service providers listed above
- **Your CCPA Rights**:
  - Right to know what data we collect
  - Right to delete personal information
  - Right to opt-out of sale (not applicable, we don't sell data)
  - Right to non-discrimination

Contact privacy@alternatefutures.com to exercise your rights.

## International Data Transfers

If data is transferred internationally:

- We use standard contractual clauses (SCCs)
- Adequate safeguards are in place per GDPR Article 46
- Self-hosted deployments remain in your chosen jurisdiction

## Privacy for Self-Hosted Deployments

If you self-host Alternate Futures:

- **You are the data controller**
- You are responsible for GDPR/CCPA compliance
- You control all data storage and processing
- No data is shared with us
- You should provide your own privacy policy to your users

## Changes to This Policy

We may update this privacy policy:

- Material changes will be notified via email
- Changes will be posted in CHANGELOG.md
- Continued use after changes constitutes acceptance
- You can always view version history on GitHub

## Transparency Reports

We commit to publishing annual transparency reports:

- Number of law enforcement requests
- Number of account terminations
- Security incidents (if any)
- Data breach notifications (if any)

## Contact Us

For privacy questions, concerns, or to exercise your rights:

**Email**: privacy@alternatefutures.com
**GitHub**: https://github.com/alternatefutures/alternatefutures-backend/issues
**Security**: security@alternatefutures.com

## Open Source Audit

This software is open source under GNU GPLv3. You can:

- Audit our code: https://github.com/alternatefutures/alternatefutures-backend
- Verify our data practices
- Run your own instance with full control
- Contribute privacy improvements

## Additional Resources

- [SECURITY.md](./SECURITY.md) - Security practices
- [LICENSE](./LICENSE) - GNU General Public License v3.0
- [CONTRIBUTING.md](./CONTRIBUTING.md) - How to contribute

---

**Alternate Futures**: Privacy-focused, censorship-resistant, open-source serverless platform.
