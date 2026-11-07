import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export const config = {
  apaleo: {
    clientId: required('APALEO_CLIENT_ID'),
    clientSecret: required('APALEO_CLIENT_SECRET'),
    propertyId: process.env.APALEO_PROPERTY_ID || 'PAR',
    identityUrl: process.env.APALEO_IDENTITY_URL || 'https://identity.apaleo.com',
    apiUrl: process.env.APALEO_API_URL || 'https://api.apaleo.com',
    channelCode: 'Direct',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  },
  port: Number(process.env.PORT) || 3000,
};
