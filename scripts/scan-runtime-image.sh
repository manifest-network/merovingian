#!/usr/bin/env bash
set -euo pipefail

# Local candidate only. No publishing, deployment, host policy changes or live
# application requests. Scanner networking is limited to downloading tooling/DB.
image=${1:?Usage: scan-runtime-image.sh IMAGE OUTPUT_DIRECTORY}
scan_dir=${2:?Usage: scan-runtime-image.sh IMAGE OUTPUT_DIRECTORY}
mkdir -p "$scan_dir/tool" "$scan_dir/private"
scanner_version=0.74.0
scanner_sha=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a
scanner_archive="$scan_dir/tool/trivy.tar.gz"
curl --fail --silent --show-error --location --max-time 120 --retry 2 \
  "https://github.com/aquasecurity/trivy/releases/download/v${scanner_version}/trivy_${scanner_version}_Linux-64bit.tar.gz" \
  --output "$scanner_archive"
printf '%s  %s\n' "$scanner_sha" "$scanner_archive" | sha256sum --check --status
tar -xzf "$scanner_archive" -C "$scan_dir/tool" trivy
docker --host unix:///var/run/docker.sock image save "$image" --output "$scan_dir/image.tar"

"$scan_dir/tool/trivy" --cache-dir "$scan_dir/cache" image --input "$scan_dir/image.tar" \
  --timeout 10m --scanners vuln,secret --list-all-pkgs --format json --output "$scan_dir/private/vulnerabilities.json"
"$scan_dir/tool/trivy" --cache-dir "$scan_dir/cache" image --input "$scan_dir/image.tar" \
  --timeout 10m --skip-db-update --format cyclonedx --output "$scan_dir/private/sbom.cdx.json"
"$scan_dir/tool/trivy" --cache-dir "$scan_dir/cache" --version --format json > "$scan_dir/scanner.json"

# Preserve digest provenance without host paths, image configuration/env dumps,
# operation journals, or the large private temporary archive in CI artifacts.
local_image_id=$(docker --host unix:///var/run/docker.sock image inspect --format '{{.Id}}' "$image")
python3 - "$scan_dir" "$local_image_id" <<'PY'
import datetime, hashlib, json, pathlib, sys, tarfile
directory = pathlib.Path(sys.argv[1])
local_image_id = sys.argv[2]
manifest_digest = None
with tarfile.open(directory / 'image.tar') as archive:
    exported = json.load(archive.extractfile('manifest.json'))
    if len(exported) != 1:
        raise RuntimeError('Expected one exported candidate image')
    config = archive.extractfile(exported[0]['Config']).read()
    config_digest = 'sha256:' + hashlib.sha256(config).hexdigest()
    if local_image_id != config_digest:
        manifest = archive.extractfile('blobs/sha256/' + local_image_id.removeprefix('sha256:')).read()
        manifest_digest = 'sha256:' + hashlib.sha256(manifest).hexdigest()
        if manifest_digest != local_image_id or json.loads(manifest)['config']['digest'] != config_digest:
            raise RuntimeError('Export does not match tested local image')
scan_path = directory / 'vulnerabilities.json'
scan = json.loads((directory / 'private/vulnerabilities.json').read_text())
if scan['Metadata']['ImageID'] != config_digest:
    raise RuntimeError('Scanned configuration differs from exported candidate')
# Trivy's ArtifactName can include the caller's personal output directory.
scan['ArtifactName'] = 'merovingian-local-candidate'
scan['Metadata'].pop('ImageConfig', None)
scan['Metadata'].pop('Reference', None)
for result in scan.get('Results', []):
    if result.get('Class') == 'os-pkgs':
        result['Target'] = 'os:' + result['Type']
    # Never publish matched secret bytes, snippets, line data, or annotations.
    if result.get('Secrets'):
        result['Secrets'] = [{key: item[key] for key in ['RuleID','Category','Severity','Title'] if key in item}
                             for item in result['Secrets']]
scan_path.write_text(json.dumps(scan, indent=2) + '\n')
sbom_path = directory / 'sbom.cdx.json'
sbom = json.loads((directory / 'private/sbom.cdx.json').read_text())
component = sbom.get('metadata', {}).get('component', {})
component['name'] = 'merovingian-local-candidate'
sbom_path.write_text(json.dumps(sbom, indent=2) + '\n')
report = {
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'configurationDigest': config_digest,
    'localImageId': local_image_id,
    'manifestDigest': manifest_digest,
    'scannerVersion': '0.74.0',
    'scannerArchiveSha256': '2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a',
    'filesSha256': {name: hashlib.sha256((directory/name).read_bytes()).hexdigest()
                    for name in ['vulnerabilities.json','sbom.cdx.json','scanner.json']},
}
(directory/'scan-provenance.json').write_text(json.dumps(report, indent=2)+'\n')
PY
node --import tsx scripts/image-security-policy.ts "$scan_dir/vulnerabilities.json" \
  "$scan_dir/scanner.json" security/image-exceptions.json "$scan_dir/policy.json"
