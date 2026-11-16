export type SetupOperationFailure = { code: 'HOST_PACKAGE_OPERATION_FAILED' | 'REGISTRATION_INCOMPLETE';
  exit: number | null; signal: string | null; operation: 'native-install' | 'native-remove' };
export class SetupError extends Error {
  readonly code: string;
  readonly nextStep: string;
  readonly failure?: SetupOperationFailure;
  constructor(code: string, nextStep: string, failure?: SetupOperationFailure) {
    super(code); this.code = code; this.nextStep = nextStep; this.failure = failure;
  }
}
export function fail(code: string, nextStep: string): never { throw new SetupError(code, nextStep); }
