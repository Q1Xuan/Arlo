export type SetupOperationFailure = { code: 'HOST_PACKAGE_OPERATION_FAILED' | 'REGISTRATION_INCOMPLETE';
  exit: number | null; signal: string | null; operation: 'native-install' | 'native-remove' };
export class SetupError extends Error {
  constructor(readonly code: string, readonly nextStep: string, readonly failure?: SetupOperationFailure) { super(code); }
}
export function fail(code: string, nextStep: string): never { throw new SetupError(code, nextStep); }
