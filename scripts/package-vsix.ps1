$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
$packageJsonPath = Join-Path $root "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json

$distDir = Join-Path $root "dist"
$buildDir = Join-Path $distDir "vsix-build"
$extensionDir = Join-Path $buildDir "extension"
$zipPath = Join-Path $distDir "$($packageJson.name)-$($packageJson.version).zip"
$vsixPath = Join-Path $distDir "$($packageJson.name)-$($packageJson.version).vsix"

if (Test-Path -LiteralPath $buildDir) {
  $resolvedBuild = Resolve-Path -LiteralPath $buildDir
  if (-not $resolvedBuild.Path.StartsWith($root.Path)) {
    throw "Refusing to remove path outside extension root: $($resolvedBuild.Path)"
  }
  Remove-Item -LiteralPath $resolvedBuild.Path -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null

Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination (Join-Path $extensionDir "package.json")
Copy-Item -LiteralPath (Join-Path $root "extension.js") -Destination (Join-Path $extensionDir "extension.js")
Copy-Item -LiteralPath (Join-Path $root "mcp-server.js") -Destination (Join-Path $extensionDir "mcp-server.js")
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $extensionDir "README.md")
Copy-Item -LiteralPath (Join-Path $root "CHANGELOG.md") -Destination (Join-Path $extensionDir "CHANGELOG.md")

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="xml" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
'@

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($packageJson.name)" Version="$($packageJson.version)" Publisher="$($packageJson.publisher)" />
    <DisplayName>$($packageJson.displayName)</DisplayName>
    <Description xml:space="preserve">$($packageJson.description)</Description>
    <Tags>Trae,Prompt,Optimizer,Harness,AI</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($packageJson.engines.vscode)" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Readme" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Set-Content -LiteralPath (Join-Path $buildDir "[Content_Types].xml") -Value $contentTypes -Encoding UTF8
Set-Content -LiteralPath (Join-Path $buildDir "extension.vsixmanifest") -Value $manifest -Encoding UTF8

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

if (Test-Path -LiteralPath $vsixPath) {
  Remove-Item -LiteralPath $vsixPath -Force
}

$items = @(
  (Join-Path $buildDir "[Content_Types].xml"),
  (Join-Path $buildDir "extension.vsixmanifest"),
  (Join-Path $buildDir "extension")
)

Compress-Archive -LiteralPath $items -DestinationPath $zipPath -Force
Rename-Item -LiteralPath $zipPath -NewName (Split-Path $vsixPath -Leaf)

if (Test-Path -LiteralPath $buildDir) {
  $resolvedBuild = Resolve-Path -LiteralPath $buildDir
  if (-not $resolvedBuild.Path.StartsWith($root.Path)) {
    throw "Refusing to remove path outside extension root: $($resolvedBuild.Path)"
  }
  Remove-Item -LiteralPath $resolvedBuild.Path -Recurse -Force
}

Write-Host "Created $vsixPath"
