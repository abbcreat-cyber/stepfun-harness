using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

internal static class OfficeLauncher {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr a,b,c,d; }
    static string Quote(string value) {
        var result=new StringBuilder("\""); int slashes=0;
        foreach(char ch in value) {
            if(ch=='\\') { slashes++; continue; }
            if(ch=='"') { result.Append('\\',slashes*2+1); result.Append(ch); slashes=0; continue; }
            result.Append('\\',slashes); slashes=0; result.Append(ch);
        }
        result.Append('\\',slashes*2); return result.Append('"').ToString();
    }
    static int Main(string[] args) {
        IntPtr job=IntPtr.Zero;
        try {
            string bin=AppDomain.CurrentDomain.BaseDirectory;
            string node=Path.GetFullPath(Path.Combine(bin,"..","..","..","node","node.exe"));
            string script=Path.GetFullPath(Path.Combine(bin,"..","office.mjs"));
            var arguments=new StringBuilder(Quote(script));
            foreach(string arg in args) arguments.Append(' ').Append(Quote(arg));
            job=CreateJobObject(IntPtr.Zero,null);
            var limit=new ExtendedLimit(); limit.basic.flags=0x2000; // Kill the entire converter tree when the wrapper is cancelled.
            int size=Marshal.SizeOf(limit); IntPtr data=Marshal.AllocHGlobal(size);
            try { Marshal.StructureToPtr(limit,data,false); if(job==IntPtr.Zero || !SetInformationJobObject(job,9,data,(uint)size)) throw new Exception("Cannot create Office process job"); }
            finally { Marshal.FreeHGlobal(data); }
            var start=new ProcessStartInfo(node,arguments.ToString()); start.UseShellExecute=false; start.CreateNoWindow=true;
            start.RedirectStandardOutput=true; start.RedirectStandardError=true;
            start.EnvironmentVariables.Remove("NODE_OPTIONS"); start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            using(var process=Process.Start(start)) {
                if(!AssignProcessToJobObject(job,process.Handle)) { process.Kill(); throw new Exception("Cannot attach Office process job"); }
                Task stdout=process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task stderr=process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                process.WaitForExit(); Task.WaitAll(stdout,stderr); return process.ExitCode;
            }
        } catch(Exception error) { Console.Error.WriteLine("Office: "+error.Message); return 1; }
        finally { if(job!=IntPtr.Zero) CloseHandle(job); }
    }
}
