// Step 1 smoke test: get a token, list properties, read one offer set.
import { config } from '../src/config.js';
import { listProperties, listOffers, getGrantedScopes, ApaleoError } from '../src/apaleoClient.js';

function plusDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

try {
  const { properties = [] } = (await listProperties()) || {};
  console.log(`\n✔ Connected. Granted scopes: ${getGrantedScopes() || '(not reported)'}`);
  console.log(`✔ ${properties.length} properties:`);
  for (const p of properties) console.log(`   - ${p.id}  ${p.name}  (${p.currencyCode}, ${p.timeZone}, ${p.status})`);

  const arrival = plusDays(5);
  const departure = plusDays(7);
  const offers = await listOffers({ propertyId: config.apaleo.propertyId, arrival, departure, adults: 2 });
  console.log(`\n✔ Offers for ${config.apaleo.propertyId} ${arrival} → ${departure}, 2 adults, channel Direct:`);
  for (const o of offers?.offers || []) {
    console.log(
      `   - ${o.unitGroup.name.padEnd(12)} ${o.ratePlan.code.padEnd(7)} ${String(o.totalGrossAmount.amount).padStart(7)} ${o.totalGrossAmount.currency}` +
        `  guarantee=${o.minGuaranteeType}  avail=${o.availableUnits}  cancel=${o.cancellationFee?.name}`,
    );
  }
  console.log('');
} catch (err) {
  if (err instanceof ApaleoError) {
    console.error(`\n✖ Apaleo error ${err.status ?? ''} on ${err.method} ${err.path}: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(`\n✖ ${err.message}`);
  }
  process.exit(1);
}
