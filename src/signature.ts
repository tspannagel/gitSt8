// Maps git's `%G?` signature status code to something displayable. Pure: no vscode.

export type SignatureState = 'good' | 'bad' | 'unknown' | 'expired' | 'revoked' | 'error' | 'none';

export interface Signature {
  state: SignatureState;
  label: string;
  signer?: string;
  key?: string;
}

export function mapSignature(code: string, signer?: string, key?: string): Signature {
  const c = (code || '').trim();
  let state: SignatureState;
  let label: string;
  switch (c) {
    case 'G': state = 'good'; label = 'Verified'; break;
    case 'B': state = 'bad'; label = 'Bad signature'; break;
    case 'U': state = 'unknown'; label = 'Unverified (unknown validity)'; break;
    case 'X': state = 'expired'; label = 'Signature expired'; break;
    case 'Y': state = 'expired'; label = 'Signing key expired'; break;
    case 'R': state = 'revoked'; label = 'Signing key revoked'; break;
    case 'E': state = 'error'; label = "Can't verify signature"; break;
    default: return { state: 'none', label: 'Not signed' };
  }
  const sig: Signature = { state, label };
  if (signer && signer.trim()) sig.signer = signer.trim();
  if (key && key.trim()) sig.key = key.trim();
  return sig;
}
