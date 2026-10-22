using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class DatabaseExe {
  static IntPtr job;

  public static int Main(string[] args) {
    string dir = System.IO.Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    string script = System.IO.Path.Combine(dir, "lib", "launch.js");
    var start = new ProcessStartInfo();
    start.FileName = "node";
    start.WorkingDirectory = dir;
    start.UseShellExecute = false;
    start.Arguments = Quote(script);
    foreach (string arg in args) start.Arguments += " " + Quote(arg);
    Process process;
    try { process = Process.Start(start); }
    catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return 1;
    }
    if (process == null) {
      Console.Error.WriteLine("node 未能启动。");
      return 1;
    }
    try { BindJob(process); }
    catch (Exception error) { Console.Error.WriteLine(error.Message); }
    process.WaitForExit();
    return process.ExitCode;
  }

  static string Quote(string value) {
    if (value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
    return "\"" + value.Replace("\"", "\\\"") + "\"";
  }

  static void BindJob(Process process) {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr ptr = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      if (!SetInformationJobObject(job, 9, ptr, (uint)size)) throw new System.ComponentModel.Win32Exception();
    } finally { Marshal.FreeHGlobal(ptr); }
    if (!AssignProcessToJobObject(job, process.Handle)) throw new System.ComponentModel.Win32Exception();
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll")]
  static extern bool SetInformationJobObject(IntPtr job, int @class, IntPtr info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
}
