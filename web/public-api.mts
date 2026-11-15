import { Config, apply, ArloContactService, type ContactOptions } from '@arlo/adapter-dsh';
import { contactDescriptor, serializeContact } from '@arlo/adapter-dsh/client';
import { prepareDshWebConsumer, patchWebPrimitives, inspectDshWebComposition, type DshCompositionReport } from '@arlo/adapter-dsh/delivery';

// Compile against the installed exports without paths or skipLibCheck. This
// consumer checks the new public declarations separately from JS inference.
const options: ContactOptions = { newSessionModel: { provider: 'local', model: 'scripted' } };
const rendered: string = serializeContact('ep-public-types', 'Contact');
void [Config, apply, ArloContactService, options, rendered, contactDescriptor, prepareDshWebConsumer, patchWebPrimitives];
const diagnosis: DshCompositionReport = inspectDshWebComposition('private-consumer');
const policy: 'formal' | 'experimental-required' = diagnosis.hostSupportPolicy;
const ready: boolean = diagnosis.requiredContracts.ready;
const runtime: string = diagnosis.runtime.arch;
void [policy, ready, runtime, diagnosis.environmentEvidence];
