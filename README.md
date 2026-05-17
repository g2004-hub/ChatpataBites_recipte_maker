# Receipt Maker

A small receipt maker website with receipt preview, print support, and a review SMS sender through SMS Gateway for Android / SMSGate.

## Run it

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in your shop and SMSGate details in `.env`.
4. Start the app:

```powershell
npm start
```

Then open `http://localhost:3000`.

Admin order history is available at `http://localhost:3000/admin`.

For permanent Railway storage, create a Supabase project, run `supabase-schema.sql` in the Supabase SQL editor, then add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Railway environment variables. Without those values, the app uses local JSON files, which are not permanent on Railway.

## What you need to provide

- Your shop name and phone number.
- Your Google review link.
- SMSGate username and password.
- SMSGate device ID from your Android SMSGate app.
- SIM slot number if the phone has multiple SIM cards.
- A test customer phone number in the same format your SMSGate account accepts, usually E.164 like `+919876543210`.
- An admin password in `.env` as `ADMIN_PASSWORD`.

## SMSGate setup

The backend sends review messages to:

```text
POST https://api.sms-gate.app/3rdparty/v1/messages
```

It uses Basic authentication and sends this style of payload:

```json
{
  "textMessage": {
    "text": "Hi Customer, thank you for your order..."
  },
  "deviceId": "your-device-id",
  "phoneNumbers": ["+919876543210"],
  "simNumber": 1,
  "ttl": 3600,
  "priority": 0
}
```

If your Postman collection uses a different SMSGate URL or payload, share that collection or the exact request details and the backend can be adjusted.
