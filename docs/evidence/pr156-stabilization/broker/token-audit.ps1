param([string]$ProcessIds)
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class CapturePackTokenAudit {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t,int cls,IntPtr data,int size,out int needed);
 public static string Integrity(int pid) {
  IntPtr p=OpenProcess(0x1000,false,pid), t=IntPtr.Zero, b=IntPtr.Zero;
  try { if(p==IntPtr.Zero || !OpenProcessToken(p,8,out t)) throw new System.ComponentModel.Win32Exception();
   int n; GetTokenInformation(t,25,IntPtr.Zero,0,out n); b=Marshal.AllocHGlobal(n);
   if(!GetTokenInformation(t,25,b,n,out n)) throw new System.ComponentModel.Win32Exception();
   return new SecurityIdentifier(Marshal.ReadIntPtr(b)).Value;
  } finally { if(b!=IntPtr.Zero) Marshal.FreeHGlobal(b); if(t!=IntPtr.Zero) CloseHandle(t); if(p!=IntPtr.Zero) CloseHandle(p); }
 }
}
'@
$ProcessIds.Split(',') | ForEach-Object { $taskPid=[int]$_; $p=Get-Process -Id $taskPid; [pscustomobject]@{pid=$taskPid;name=$p.ProcessName;session=$p.SessionId;integritySid=[CapturePackTokenAudit]::Integrity($taskPid)} } | ConvertTo-Json
