$filePath = "renderer.js"
$content = Get-Content $filePath -Raw
$lines = $content -split "`n"

# Build list of indices to remove
$toRemoveIndices = @()

# 1. Remove const declarations for auto-mask/auto-remove features
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    
    if ($line -match '^\s*const suggestStrengthInput\s*=' -or
        $line -match '^\s*const suggestPresetLowBtn\s*=' -or
        $line -match '^\s*const suggestPresetMediumBtn\s*=' -or
        $line -match '^\s*const suggestPresetHighBtn\s*=' -or
        $line -match '^\s*const suggestMaskBtn\s*=' -or
        $line -match '^\s*const suggestQueueBtn\s*=' -or
        $line -match '^\s*const autoRemoveBtn\s*=' -or
        $line -match '^\s*let suggestStrength\s*=.*Number') {
        $toRemoveIndices += $i
    }
}

# 2. Remove references to these in classList.toggle
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match 'suggestPresetLowBtn\?\.classList\.toggle|suggestPresetMediumBtn\?\.classList\.toggle|suggestPresetHighBtn\?\.classList\.toggle') {
        $toRemoveIndices += $i
    }
}

# 3. Remove lines that update suggestStrengthInput.value
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if (($line -match 'if \(suggestStrengthInput\)\s*{' -or 
         $line -match 'suggestStrengthInput\.value\s*=\s*String' -or
         $line -match 'suggestStrengthInput\.value\s*=' ) -and
        $i > 100) { # Avoid catching line 32 declaration
        # Check if this is part of a multi-line if block
        if ($line -match '^\s*suggestStrengthInput\.value') {
            $toRemoveIndices += $i
        }
    }
}

# Remove duplicates and sort descending (so we remove from end first)
$toRemoveIndices = $toRemoveIndices | Sort-Object -Unique | Sort-Object -Descending

Write-Host "Will remove $($toRemoveIndices.Count) lines in first pass"
Write-Host "Sample lines to remove:"
$toRemoveIndices[0..4] | ForEach-Object {
    Write-Host "  Line $($_ + 1): $($lines[$_].Substring(0, [Math]::Min(70, $lines[$_].Length)))"
}
