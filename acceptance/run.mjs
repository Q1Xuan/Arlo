// Keep the established platform acceptance entry and its options intact.
// Compatibility validation is opt-in and operates on one selected host tuple.
if (process.argv[2] === '--compatibility') {
  const { validate } = await import('./compatibility.mjs');
  await validate(process.argv.slice(3));
} else await import('./platform-run.mjs');
