param(
    [string]$Sdk = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$Jdk = $env:JAVA_HOME,
    # A different package installs next to the existing app instead of replacing it, e.g. -Package be.keypharm.rfid.poc.dev -Label 'Keypharm RFID POC Dev'.
    [string]$Package = 'be.keypharm.rfid.poc',
    [string]$Label = ''
)
$ErrorActionPreference = 'Stop'
if (!$Jdk) { $Jdk = 'C:\Program Files\Java\jdk-17' }
$project = Split-Path -Parent $PSScriptRoot
$src = Join-Path $project 'app\src\main'
$vendor = Join-Path $project 'app\libs\DeviceAPI_ver20251103_release.aar'
if (!(Test-Path -LiteralPath $vendor)) { throw 'Place the Chainway DeviceAPI AAR in app/libs.' }
$tool = Join-Path $Sdk 'build-tools\34.0.0'
$platform = Join-Path $Sdk 'platforms\android-34\android.jar'
$work = Join-Path $project ("build\sdk-" + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $work
$android = Join-Path $work 'android.jar'
Copy-Item -LiteralPath $platform -Destination $android
$classes = Join-Path $work 'classes'
$generated = Join-Path $work 'generated'
$dex = Join-Path $work 'dex'
$null = New-Item -ItemType Directory -Path $classes,$generated,$dex
Add-Type -AssemblyName System.IO.Compression.FileSystem
$vendorDir = Join-Path $work 'chainway'
[IO.Compression.ZipFile]::ExtractToDirectory($vendor, $vendorDir)
$aarClasses = Join-Path $vendorDir 'classes.jar'
function Run([string]$program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE) { throw "$program failed with exit code $LASTEXITCODE" }
}
$manifestPath = Join-Path $work 'AndroidManifest.xml'
[xml]$manifest = Get-Content -LiteralPath (Join-Path $src 'AndroidManifest.xml') -Raw
$manifest.manifest.SetAttribute('package',$Package)
$ns = 'http://schemas.android.com/apk/res/android'
# Version comes from app/build.gradle so the Gradle and offline builds cannot drift.
$gradle = Get-Content -LiteralPath (Join-Path $project 'app\build.gradle') -Raw
$versionCode = [regex]::Match($gradle, 'versionCode (\d+)').Groups[1].Value
$versionName = [regex]::Match($gradle, "versionName '([^']+)'").Groups[1].Value
if (!$versionCode -or !$versionName) { throw 'Could not read versionCode/versionName from app/build.gradle.' }
$null = $manifest.manifest.SetAttribute('versionCode',$ns,$versionCode)
$null = $manifest.manifest.SetAttribute('versionName',$ns,$versionName)
$null = $manifest.manifest.application.SetAttribute('debuggable',$ns,'true')
$null = $manifest.manifest.application.activity.SetAttribute('name',$ns,'be.keypharm.rfid.MainActivity')
$null = $manifest.manifest.application.provider.SetAttribute('name',$ns,'be.keypharm.rfid.EvidenceProvider')
$null = $manifest.manifest.application.provider.SetAttribute('authorities',$ns,"$Package.evidence")
if ($Label) { $null = $manifest.manifest.application.SetAttribute('label',$ns,$Label) }
$suffix = if ($Package -ne 'be.keypharm.rfid.poc') { '-' + $Package.Split('.')[-1] } else { '' }
$manifest.Save($manifestPath)
$resources = Join-Path $work 'resources.zip'
$appResources = Join-Path $work 'app-resources.zip'
$unsigned = Join-Path $work 'unsigned.apk'
Run "$tool\aapt2.exe" @('compile','--dir',"$vendorDir\res",'-o',$resources)
Run "$tool\aapt2.exe" @('compile','--dir',"$src\res",'-o',$appResources)
Run "$tool\aapt2.exe" @('link','-I',$android,'--manifest',$manifestPath,'--min-sdk-version','30','--target-sdk-version','34','-A',"$src\assets",'--java',$generated,'--extra-packages','com.rscja.deviceapi','-o',$unsigned,$resources,$appResources)
$sources = @(Get-ChildItem -LiteralPath "$src\java",$generated -Recurse -Filter *.java | ForEach-Object FullName)
Run "$Jdk\bin\javac.exe" (@('--release','17','-encoding','UTF-8','-classpath',"$android;$aarClasses",'-d',$classes) + $sources)
$appJar = Join-Path $work 'app.jar'
Run "$Jdk\bin\jar.exe" @('cf',$appJar,'-C',$classes,'.')
$env:JAVA_HOME = $Jdk
Run "$tool\d8.bat" @('--lib',$android,'--min-api','30','--output',$dex,$appJar,$aarClasses)
$apk = [IO.Compression.ZipFile]::Open($unsigned,[IO.Compression.ZipArchiveMode]::Update)
try {
    foreach ($file in Get-ChildItem -LiteralPath $dex -Filter '*.dex') {
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($apk,$file.FullName,$file.Name)
    }
    foreach ($abi in 'arm64-v8a','armeabi-v7a') {
        foreach ($file in Get-ChildItem -LiteralPath "$vendorDir\jni\$abi" -Filter '*.so') {
            $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($apk,$file.FullName,"lib/$abi/$($file.Name)")
        }
    }
} finally { $apk.Dispose() }
$aligned = Join-Path $work 'aligned.apk'
Run "$tool\zipalign.exe" @('-f','-p','4',$unsigned,$aligned)
$keystore = Join-Path $project 'build\debug.keystore'
if (!(Test-Path -LiteralPath $keystore)) {
    Run "$Jdk\bin\keytool.exe" @('-genkeypair','-keystore',$keystore,'-storepass','android','-alias','androiddebugkey','-keypass','android','-dname','CN=Android Debug','-keyalg','RSA','-keysize','2048','-validity','10000')
}
$output = Join-Path $project "build\keypharm-poc-$versionName$suffix-debug.apk"
Run "$tool\apksigner.bat" @('sign','--ks',$keystore,'--ks-pass','pass:android','--key-pass','pass:android','--out',$output,$aligned)
Run "$tool\apksigner.bat" @('verify',$output)
Write-Output $output
