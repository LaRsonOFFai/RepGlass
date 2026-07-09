# OpenAI subscription gateway

ChatGPT Free/Go/Plus/Pro/Business subscriptions cannot be used directly as
OpenAI API billing credentials for a third-party Electron app. ChatGPT billing
and API Platform billing are separate OpenAI products.

RepGlass supports two safe production modes:

1. Personal API key: the user enters an OpenAI Platform API key.
2. Managed subscription gateway: the user signs in to your app account, your
   backend verifies that the user has an active subscription, and the backend
   returns a short-lived or virtual OpenAI key for Glass to use.

Do not read Codex or ChatGPT cached tokens from `~/.codex/auth.json`, the OS
keychain, or browser cookies. Those credentials are not a public auth surface
for this app.

## Desktop configuration

Set the gateway URL before starting RepGlass:

```powershell
$env:PICKLE_SUBSCRIPTION_GATEWAY_URL="https://your-domain.example/api/openai/virtual-key"
npm start
```

`PICKLE_OPENAI_GATEWAY_URL` is also accepted for compatibility.

When a Firebase user signs in, RepGlass sends:

```json
{
  "email": "user@example.com",
  "provider": "openai",
  "product": "glass-desktop"
}
```

with the Firebase ID token in the `Authorization: Bearer <token>` header.

The gateway should verify the Firebase token, check the user's subscription,
and return one of these shapes:

```json
{
  "data": {
    "virtualKey": "vk_...",
    "subscriptionStatus": "active",
    "plan": "pro",
    "provider": "openai"
  }
}
```

or:

```json
{
  "virtualKey": "vk_...",
  "status": "active",
  "plan": "pro"
}
```

The key can be a Portkey virtual key, a short-lived proxy token, or any token
accepted by your OpenAI proxy. Keep the real OpenAI API key on the server only.

## Recommended backend

For production:

- Use Stripe or another billing provider to manage your app subscription.
- Store subscription status by Firebase UID, not only email.
- Generate short-lived virtual keys or proxy all OpenAI calls server-side.
- Add rate limits per user and plan.
- Rotate server OpenAI keys and never send them to the desktop client.

## What this is not

This is not ChatGPT Plus/Pro pass-through billing. Users cannot bring a ChatGPT
subscription and have arbitrary third-party API usage billed to it. If a user
wants direct personal usage, they need an OpenAI Platform API key.
