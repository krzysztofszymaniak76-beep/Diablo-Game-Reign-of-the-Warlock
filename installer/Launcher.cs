using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Reign of the Warlock")]
[assembly: AssemblyProduct("Reign of the Warlock")]
[assembly: AssemblyCompany("Kris Labs PL")]
[assembly: AssemblyVersion("0.2.0.0")]
[assembly: AssemblyFileVersion("0.2.0.0")]

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(folder, "Start-Game.ps1");
            if (!File.Exists(script))
                throw new FileNotFoundException("Brakuje pliku Start-Game.ps1.", script);

            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = folder,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var process = Process.Start(start))
            {
                string output = process.StandardOutput.ReadToEnd();
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    string details = (output + Environment.NewLine + error).Trim();
                    if (details.Length > 1800) details = details.Substring(details.Length - 1800);
                    throw new InvalidOperationException(details.Length > 0
                        ? details
                        : "Nie udało się uruchomić gry. Sprawdź dziennik w folderze danych użytkownika.");
                }
            }
            return 0;
        }
        catch (Exception exception)
        {
            MessageBox.Show(exception.Message, "Reign of the Warlock - błąd uruchamiania",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
