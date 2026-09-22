param(
  [Parameter(Mandatory = $true)][ValidateSet('write', 'read', 'delete', 'exists')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$UserName = 'ai-usage-tracker'
)

# Minimal Windows Credential Manager bridge (advapi32 CredWriteW/CredReadW/CredDeleteW).
# The secret travels over stdin/stdout as Base64 only - it never appears on a
# command line, in a transcript, or in an error message.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CredMgr {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags;
    public int Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, int type, uint flags, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDeleteW(string target, int type, uint flags);

  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);

  private const int CRED_TYPE_GENERIC = 1;
  private const int CRED_PERSIST_LOCAL_MACHINE = 2;

  public static void Write(string target, string userName, byte[] secret) {
    byte[] blob = (byte[])secret.Clone();
    IntPtr blobPtr = Marshal.AllocHGlobal(blob.Length);
    Marshal.Copy(blob, 0, blobPtr, blob.Length);
    IntPtr targetPtr = Marshal.StringToHGlobalUni(target);
    IntPtr userPtr = Marshal.StringToHGlobalUni(userName);
    CREDENTIAL cred = new CREDENTIAL();
    cred.Flags = 0;
    cred.Type = CRED_TYPE_GENERIC;
    cred.TargetName = targetPtr;
    cred.CredentialBlobSize = (uint)blob.Length;
    cred.CredentialBlob = blobPtr;
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
    cred.UserName = userPtr;
    try {
      if (!CredWriteW(ref cred, 0)) throw new Exception("CredWriteW failed: " + Marshal.GetLastWin32Error());
    } finally {
      Marshal.FreeHGlobal(blobPtr);
      Marshal.FreeHGlobal(targetPtr);
      Marshal.FreeHGlobal(userPtr);
    }
  }

  public static byte[] Read(string target) {
    IntPtr credPtr;
    if (!CredReadW(target, CRED_TYPE_GENERIC, 0, out credPtr)) return null;
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize == 0) return new byte[0];
      byte[] blob = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, blob, 0, blob.Length);
      return blob;
    } finally {
      CredFree(credPtr);
    }
  }

  public static void Delete(string target) {
    if (!CredDeleteW(target, CRED_TYPE_GENERIC, 0)) {
      int err = Marshal.GetLastWin32Error();
      if (err != 1168) throw new Exception("CredDeleteW failed: " + err); // 1168 = not found
    }
  }
}
'@

function Read-StdinBase64 {
  # Slurp everything; the secret never touches a variable in a command line.
  $stdin = [Console]::In.ReadToEnd();
  return [Convert]::FromBase64String($stdin.Trim());
}

try {
  switch ($Action) {
    'write' {
      $bytes = Read-StdinBase64
      [CredMgr]::Write($Target, $UserName, $bytes)
      Write-Output 'OK'
    }
    'read' {
      $bytes = [CredMgr]::Read($Target)
      if ($null -eq $bytes) { Write-Output 'NOT_FOUND'; exit 0 }
      Write-Output ([Convert]::ToBase64String($bytes))
    }
    'exists' {
      $bytes = [CredMgr]::Read($Target)
      if ($null -eq $bytes) { Write-Output 'ABSENT' } else { Write-Output 'PRESENT' }
    }
    'delete' {
      [CredMgr]::Delete($Target)
      Write-Output 'OK'
    }
  }
} catch {
  # Error text only; never includes the secret (it is never materialized as text).
  Write-Output ('ERROR: ' + $_.Exception.Message)
  exit 1
}
