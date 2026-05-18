# Receipt Maker

A small receipt maker website with receipt preview, print support, bill-link SMS sending, UPI payment links, and delayed review SMS sending through SMS Gateway for Android / SMSGate.

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
- A public app URL as `PUBLIC_BASE_URL` for bill links when deployed.
- A long private `BILL_LINK_SECRET` for secure customer bill links.
- SMSGate username and password.
- SMSGate device ID from your Android SMSGate app.
- SIM slot number if the phone has multiple SIM cards.
- A test customer phone number in the same format your SMSGate account accepts, usually E.164 like `+919876543210`.
- An admin password in `.env` as `ADMIN_PASSWORD`.

## Bill links and review SMS

The "Send bill to customer" button sends the customer a secure bill preview link immediately. The bill page only shows that customer's bill and UPI payment options for `8260586748@ybl`.

After the bill SMS is sent successfully, the app queues a Google review SMS for 10 minutes later. With Supabase configured, the queue is stored in `scheduled_review_messages`; without Supabase, it is stored locally in `data/scheduled-review-messages.json`.

## SMSGate setup

The backend sends bill and review messages to:

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
