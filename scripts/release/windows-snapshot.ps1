function Set-OrePrivate([string]$Path) {
    Assert-OrePath $Path $Path | Out-Null
    $acl = [IO.Directory]::GetAccessControl($Path,[Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    [IO.Directory]::SetAccessControl($Path,$acl)
}

# Windows PowerShell 5.1 archive policy, also embedded in the standalone asset.
$OreSourceInputs = @('build-portable.ps1','package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','src','public','migrations','scripts/release','LICENSE','docs/RELEASES.md')
function Add-OreType([string]$TypeDefinition) {
    # Framework CodeDOM's default elevated temp-directory creation uses a
    # legacy native path API. An explicit private TempFiles directory avoids
    # that path, including for Unicode installation names, without global edits.
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('ore-types-'+[guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    Set-OrePrivate $directory
    $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
    $parameters = New-Object CodeDom.Compiler.CompilerParameters
    $parameters.GenerateInMemory = $true
    $parameters.TempFiles = New-Object CodeDom.Compiler.TempFileCollection($directory,$false)
    $parameters.ReferencedAssemblies.Add('System.dll') | Out-Null
    try {
        $result = $provider.CompileAssemblyFromSource($parameters,$TypeDefinition)
        if ($result.Errors.HasErrors) { throw ($result.Errors | Out-String) }
        $result.CompiledAssembly | Out-Null
    } finally {
        $parameters.TempFiles.Dispose()
        $provider.Dispose()
        [IO.Directory]::Delete($directory,$true)
    }
}
function Assert-OrePath([string]$Root, [string]$Path) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Path)
    if (!$full.Equals($rootPath,[StringComparison]::OrdinalIgnoreCase) -and !$full.StartsWith($rootPath+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Managed path escapes installation.' }
    $cursor = $full
    while ($cursor) {
        # GetAttributes also detects dangling reparse points, unlike Test-Path.
        try { $attributes = [IO.File]::GetAttributes($cursor) }
        catch [IO.FileNotFoundException] { $attributes = 0 }
        catch [IO.DirectoryNotFoundException] { $attributes = 0 }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in managed path.' }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}
function Assert-OreTree([string]$Root) {
    Assert-OrePath $Root $Root | Out-Null
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Root)) {
        Assert-OrePath $Root $entry | Out-Null
        if ([IO.Directory]::Exists($entry)) { Assert-OreTree $entry }
    }
}
function Expand-OreZip([string]$Archive, [string]$ExpectedRoot, [string]$Destination, [switch]$Source, [switch]$LongPaths) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ($LongPaths) {
        if ($Source) { throw 'Long-path extraction is reserved for prepared packages.' }
        Initialize-OreLongPaths
        [OreLongPaths]::Assert($Destination,$Destination) | Out-Null
        if ([OreLongPaths]::Exists($Destination)) { throw 'Extraction destination must be new.' }
    } else {
        Assert-OrePath $Destination $Destination | Out-Null
        if ([IO.Directory]::Exists($Destination) -or [IO.File]::Exists($Destination)) { throw 'Extraction destination must be new.' }
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $files = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $entries = New-Object 'Collections.Generic.List[IO.Compression.ZipArchiveEntry]'
        [long]$total = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            $directory = $name.EndsWith('/')
            $parts = $name.TrimEnd('/').Split('/')
            if ($parts.Count -lt 1 -or $parts[0] -cne $ExpectedRoot -or $name.Length -gt 240 -or $name.EndsWith('//')) { throw ('Unexpected ZIP root/path length: '+$name) }
            foreach ($part in $parts) {
                if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[\\:<>"|?*~\x00-\x1f]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(?i:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)') { throw 'Unsafe Windows ZIP name.' }
            }
            $kind = (($entry.ExternalAttributes -shr 16) -band 0xf000)
            if (($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000) -or ($entry.ExternalAttributes -band 0x400) -or ($kind -eq 0x4000 -and !$directory) -or ($kind -eq 0x8000 -and $directory)) { throw 'Unsupported ZIP entry type.' }
            $key = $parts -join '/'
            if (!$seen.Add($key)) { throw 'Duplicate/case-equivalent ZIP entry.' }
            if (!$directory) { $files.Add($key) | Out-Null }
            $total += $entry.Length
            if ($total -gt 2GB -or $zip.Entries.Count -gt 100000 -or ($directory -and $entry.Length -ne 0)) { throw 'ZIP extraction bounds exceeded.' }
            $entries.Add($entry)
        }
        if (!$entries.Count) { throw 'Empty ZIP.' }
        foreach ($key in $seen) {
            $ancestor = $key
            while ($ancestor.Contains('/')) {
                $ancestor = $ancestor.Substring(0,$ancestor.LastIndexOf('/'))
                if ($files.Contains($ancestor)) { throw 'ZIP file/directory collision.' }
            }
        }
        # The complete listing has passed before the first output is created.
        if ($LongPaths) { [OreLongPaths]::CreateDirectory($Destination,$Destination) }
        else { [IO.Directory]::CreateDirectory($Destination) | Out-Null }
        foreach ($entry in $entries) {
            $relative = $entry.FullName.Substring($ExpectedRoot.Length).TrimStart('/')
            if (!$relative) { continue }
            if ($Source) {
                $allowed = $false
                foreach ($inputPath in $OreSourceInputs) {
                    if ($relative -ceq $inputPath -or $relative.StartsWith($inputPath+'/',[StringComparison]::Ordinal)) { $allowed = $true; break }
                }
                if (!$allowed) { continue }
            }
            $targetPath = $Destination.TrimEnd('\')+'\'+$relative.Replace('/','\')
            if ($LongPaths) {
                $target = [OreLongPaths]::Assert($Destination,$targetPath)
                if ($entry.FullName.EndsWith('/')) { [OreLongPaths]::CreateDirectory($Destination,$target); continue }
                [OreLongPaths]::CreateDirectory($Destination,[OreLongPaths]::Parent($target))
            } else {
                $target = Assert-OrePath $Destination $targetPath
                if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            }
            $inputStream = $entry.Open()
            $outputStream = if ($LongPaths) { [OreLongPaths]::CreateFile($Destination,$target) } else { [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None) }
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
        if ($Source) {
            foreach ($inputPath in $OreSourceInputs) {
                if (!(Test-Path -LiteralPath (Join-Path $Destination $inputPath))) { throw ('Missing archive build input: '+$inputPath) }
            }
        }
    } finally { $zip.Dispose() }
}

# Windows PowerShell 5.1 can retain legacy .NET path handling even on a current
# OS. Prepared packages use Unicode Win32 I/O with extended paths, avoiding any
# registry, host configuration or machine-policy change. Normal paths remain
# the public API so Node arguments and persisted selections are unchanged.
function Initialize-OreLongPaths {
    if ('OreLongPaths' -as [type]) { return }
    Add-OreType -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class OreLongPaths {
    const uint InvalidAttributes = 0xffffffff, DirectoryFlag = 0x10, ReparseFlag = 0x400;
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct FindData {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint SizeHigh, SizeLow, Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=14)] public string AlternateName;
    }
    [DllImport("api-ms-win-core-path-l1-1-0.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int PathCchCanonicalizeEx(StringBuilder output,UIntPtr length,string path,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern bool CreateDirectoryW(string path,IntPtr attributes);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr attributes,uint mode,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern IntPtr FindFirstFileW(string path,out FindData data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern bool FindNextFileW(IntPtr handle,out FindData data);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern bool DeleteFileW(string path);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern bool RemoveDirectoryW(string path);
    static string Normalize(string path) {
        path=path.Replace('/','\\');
        if (path.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) path=@"\\"+path.Substring(8);
        else if (path.StartsWith(@"\\?\",StringComparison.Ordinal)) path=path.Substring(4);
        if (path.StartsWith(@"\\.\",StringComparison.Ordinal) || !(path.StartsWith(@"\\",StringComparison.Ordinal) || (path.Length>=3 && char.IsLetter(path[0]) && path[1]==':' && path[2]=='\\'))) throw new IOException("Expected an absolute filesystem path.");
        var buffer=new StringBuilder(32768);
        // PATHCCH_ALLOW_LONG_PATHS canonicalizes beyond MAX_PATH without the
        // caller's long-path opt-in. Normalize separators before comparison.
        int result=PathCchCanonicalizeEx(buffer,new UIntPtr((uint)buffer.Capacity),path,1);
        if (result<0) Marshal.ThrowExceptionForHR(result);
        string normalized=buffer.ToString();
        if (normalized.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) normalized=@"\\"+normalized.Substring(8);
        else if (normalized.StartsWith(@"\\?\",StringComparison.Ordinal)) normalized=normalized.Substring(4);
        return normalized.Length==3 && normalized[1]==':' ? normalized : normalized.TrimEnd('\\');
    }
    static string Native(string path) { return path.StartsWith(@"\\",StringComparison.Ordinal) ? @"\\?\UNC\"+path.Substring(2) : @"\\?\"+path; }
    public static string Parent(string path) {
        int index=path.LastIndexOf('\\');
        if (index<0 || index==2) return null;
        if (path.StartsWith(@"\\",StringComparison.Ordinal) && index<=path.IndexOf('\\',2)) return null;
        return path.Substring(0,index);
    }
    static uint Attributes(string path) {
        uint value=GetFileAttributesW(Native(path));
        if (value!=InvalidAttributes) return value;
        int error=Marshal.GetLastWin32Error();
        if (error==2 || error==3) return 0;
        throw new Win32Exception(error);
    }
    public static string Assert(string root,string path) {
        root=Normalize(root); path=Normalize(path);
        if (!path.Equals(root,StringComparison.OrdinalIgnoreCase) && !path.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) throw new IOException("Managed path escapes installation.");
        for (string cursor=path;cursor!=null;cursor=Parent(cursor)) if ((Attributes(cursor)&ReparseFlag)!=0) throw new IOException("Reparse point in managed path.");
        return path;
    }
    public static bool Exists(string path) { path=Assert(path,path); return Attributes(path)!=0; }
    public static void CreateDirectory(string root,string path) {
        path=Assert(root,path);
        uint attributes=Attributes(path);
        if ((attributes&DirectoryFlag)!=0) return;
        if (attributes!=0) throw new IOException("Managed directory collides with a file.");
        string parent=Parent(path);
        if (parent!=null && Attributes(parent)==0) CreateDirectory(root,parent);
        if (!CreateDirectoryW(Native(path),IntPtr.Zero)) throw new Win32Exception();
    }
    static FileStream Open(string root,string path,bool create) {
        path=Assert(root,path);
        var handle=CreateFileW(Native(path),create?0x40000000u:0x80000000u,create?0u:1u,IntPtr.Zero,create?1u:3u,0x80u,IntPtr.Zero);
        if (handle.IsInvalid) { int error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error); }
        try { return new FileStream(handle,create?FileAccess.Write:FileAccess.Read,65536,false); }
        catch { handle.Dispose();throw; }
    }
    public static FileStream CreateFile(string root,string path) { return Open(root,path,true); }
    public static FileStream OpenRead(string root,string path) { return Open(root,path,false); }
    public static long Length(string root,string path) { using(var stream=Open(root,path,false)) return stream.Length; }
    public static string Hash(string root,string path) {
        using(var stream=Open(root,path,false)) using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
    }
    static List<FindData> Entries(string root,string directory) {
        directory=Assert(root,directory);
        FindData data;
        IntPtr handle=FindFirstFileW(Native(directory)+@"\*",out data);
        if (handle==new IntPtr(-1)) { int error=Marshal.GetLastWin32Error();if(error==2)return new List<FindData>();throw new Win32Exception(error); }
        var entries=new List<FindData>();
        try {
            do {
                if (data.Name=="." || data.Name=="..") continue;
                if ((data.Attributes&ReparseFlag)!=0) throw new IOException("Reparse point in managed path.");
                entries.Add(data);
            } while(FindNextFileW(handle,out data));
            int error=Marshal.GetLastWin32Error();
            if(error!=18) throw new Win32Exception(error);
        } finally { FindClose(handle); }
        return entries;
    }
    static void Walk(string root,string directory,List<string> files) {
        foreach(var entry in Entries(root,directory)) {
            string path=Assert(root,directory+"\\"+entry.Name);
            if ((entry.Attributes&DirectoryFlag)!=0) Walk(root,path,files);
            else { files.Add(path);if(files.Count>100000)throw new IOException("Managed file count exceeded."); }
        }
    }
    public static string[] Files(string root) { root=Assert(root,root);var files=new List<string>();Walk(root,root,files);return files.ToArray(); }
    public static void DeleteTree(string root) { root=Assert(root,root);DeleteDirectory(root,root); }
    static void DeleteDirectory(string root,string directory) {
        foreach(var entry in Entries(root,directory)) {
            string path=Assert(root,directory+"\\"+entry.Name);
            if((entry.Attributes&DirectoryFlag)!=0) DeleteDirectory(root,path);
            else if(!DeleteFileW(Native(path))) throw new Win32Exception();
        }
        if(!RemoveDirectoryW(Native(directory))) throw new Win32Exception();
    }
}
'@
}
function Assert-OreLongPath([string]$Root,[string]$Path) { Initialize-OreLongPaths; return [OreLongPaths]::Assert($Root,$Path) }
function Assert-OreLongTree([string]$Root) { Initialize-OreLongPaths; [OreLongPaths]::Files($Root) | Out-Null }
function Get-OreLongFiles([string]$Root) { Initialize-OreLongPaths; return [OreLongPaths]::Files($Root) }
function Get-OreLongHash([string]$Root,[string]$Path) { Initialize-OreLongPaths; return [OreLongPaths]::Hash($Root,$Path) }
function Get-OreLongLength([string]$Root,[string]$Path) { Initialize-OreLongPaths; return [OreLongPaths]::Length($Root,$Path) }
function Remove-OreLongTree([string]$Root) { Initialize-OreLongPaths; [OreLongPaths]::DeleteTree($Root) }
