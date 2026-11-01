# Windows OCR for Joty screen clips and pasted images.
# Runs in Windows PowerShell 5.1 (WinRT projection); no modules or services.
# Prints {"text","language","lines"} as UTF-8 JSON; on failure writes the
# reason to stderr and exits 1.
param([Parameter(Mandatory = $true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$stream = $null
$bitmap = $null
$converted = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
            $_.GetGenericArguments().Count -eq 1 -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1
    if ($null -eq $script:asTask) { throw 'WinRT AsTask bridge is unavailable.' }
    function Await-WinRT($Operation, [Type]$ResultType) {
        $task = $script:asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
        if (-not $task.Wait(30000)) {
            try { $Operation.Cancel() } catch {}
            throw 'WinRT operation timed out.'
        }
        return ,($task.GetAwaiter().GetResult())
    }
    $fullPath = [System.IO.Path]::GetFullPath($ImagePath)
    $file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($decoder.PixelWidth -gt $max -or $decoder.PixelHeight -gt $max) {
        throw "Image exceeds OCR's maximum dimension ($max pixels); resize it first."
    }
    $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
        $bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'No supported OCR language is installed for this Windows user.' }
    $result = Await-WinRT ($engine.RecognizeAsync($converted)) ([Windows.Media.Ocr.OcrResult])
    $payload = [ordered]@{
        text = $result.Text
        language = $engine.RecognizerLanguage.LanguageTag
        lines = @($result.Lines | ForEach-Object { $_.Text })
    }
    [Console]::Out.Write(($payload | ConvertTo-Json -Compress -Depth 4))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $converted) { $converted.Dispose() }
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
