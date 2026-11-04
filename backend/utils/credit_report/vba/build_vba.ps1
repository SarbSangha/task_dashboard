# Rebuilds vbaProject.bin (the dashboard workbook's macros) from the sources
# beside it: ThisWorkbook.cls (filters in sync on every sheet, the From / To
# calendar), DatePick.frm.vba (the calendar form's code) and DayButton.cls.
# Needs Windows Excel with "Trust access to the VBA project object model"
# ticked (File > Options > Trust Center > Macro Settings) while it runs.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File build_vba.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Source($name) { Get-Content -Raw -Encoding UTF8 (Join-Path $here $name) }
function SetCode($component, $code) {
    $module = $component.CodeModule
    if ($module.CountOfLines -gt 0) { $module.DeleteLines(1, $module.CountOfLines) }
    $module.AddFromString($code)
}
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("dashboard-vba-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$xl = New-Object -ComObject Excel.Application
$xl.DisplayAlerts = $false
try {
    $wb = $xl.Workbooks.Add()
    $project = $wb.VBProject
    $day = $project.VBComponents.Add(2)          # class module
    $day.Name = "DayButton"
    SetCode $day (Source "DayButton.cls")
    $form = $project.VBComponents.Add(3)         # user form
    $form.Name = "DatePick"
    SetCode $form (Source "DatePick.frm.vba")
    SetCode $project.VBComponents.Item("ThisWorkbook") (Source "ThisWorkbook.cls")
    $xlsm = Join-Path $tmp "macro.xlsm"
    $wb.SaveAs($xlsm, 52)        # xlOpenXMLWorkbookMacroEnabled
    $wb.Close($false)
} finally {
    $xl.Quit()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($xlsm)
try {
    $entry = $zip.GetEntry("xl/vbaProject.bin")
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $here "vbaProject.bin"), $true)
} finally { $zip.Dispose() }
Remove-Item -Recurse -Force $tmp
"wrote " + (Join-Path $here "vbaProject.bin")
