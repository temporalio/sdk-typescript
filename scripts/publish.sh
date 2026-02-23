#!/bin/zsh
set -euo pipefail

local workdir=$( mktemp -d -t sdk-typescript-release )
trap 'cd / && rm -rf "$workdir"' EXIT
cd "$workdir"

# FIXME Make this a parameter
# e.g. 'main' or 'releases/1.10.x'
local source_branch=main
export version="1.15.0"


# Manually download all native artifacts from the latest build

mkdir -p artifacts package/releases
open artifacts

echo -e 'Please do the following:'
echo -e ' 1. Open the \e]8;;https://github.com/temporalio/sdk-typescript/actions/workflows/ci.yml?query=branch%3A'"$source_branch"'\e\\GHA status page\e]8;;\e\\ for the "Continuous Integration" workflow, on branch main.'
echo -e ' 2. From there, select the latest execution'
echo -e ' 3. Download all corebridge-native-* artifacts to the "artifacts" directory that just opened'

echo
echo -e 'Press ENTER once this is completed.'
read enterKey

local count=$( find artifacts -type f -name "corebridge-native-*.zip" | wc -l )
if [ $count -ne 5 ]; then
    echo "The 'artifacts' directory does not contain exactly 5 files named 'corebridge-native-*.zip'"
    echo "Aborting"
    exit 1
fi

git clone --branch $source_branch --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/sdk-typescript.git
cd sdk-typescript

# Extract native libs and organize them correctly
for name in ../artifacts/*.zip ; do
    unzip -q ${name} -d packages/core-bridge/releases/
done

pnpm install --frozen-lockfile
pnpm --recursive --stream --filter '!@temporalio/core-bridge' --filter '!typescript-sdk' run build

echo
echo 'Does this look correct?'
echo
ls -l packages/core-bridge/releases/*/*

echo
echo 'Press ENTER to go on with publishing, or Ctrl+C to abort'

read enterKey

echo 'Bumping version numbers...'

pnpm -r exec npm version "${version}"
git switch -c "release-v${version}"
git add packages/*/package.json scripts/package.json
git commit -m "Release v${version}"
git push origin "release-v${version}"

gh pr create
git switch main
git pull



echo -e 'Please do the following:'
echo -e ' 1. Open the \e]8;https://github.com/temporalio/sdk-typescript/releases/new?tag=v'"$version"'\e\\GitHub New Release page\e]8;;\e\\ and select the 'v"$version"' tag.'
echo -e ' 2. In the Release Title field, enter '"$version"''
echo -e ' 3. Paste the release notes inkto the description field'
if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
    echo -e ' 4. Make sure that the "Set as a pre-release" checkbox is unchecked'
    echo -e '    and that the "Set as the latest release" checkbox is checked'
else
    echo -e ' 4. Make sure that the "Set as a pre-release" checkbox is checked'
    echo -e '    and that the "Set as the latest release" checkbox is unchecked'
fi
echo -e ' 5. Press the "Save draft" button, then ask someone else to review'
echo -e ' 6. Press the "Publish Release" buton to complete the release process'

echo
echo -e 'Press ENTER once this is completed.'
read enterKey

cd "$workdir"

if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then

  # Update the feature repo
  (
    git clone --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/features.git
    cd features

    # Note this only update _regular_ dependencies. There's no dev/peer dependencies at the moment.
    npm install $(jq -r '.dependencies | keys[] | select(startswith("@temporalio/")) | . + "@^" + env.version' package.json)

    git checkout -b "typescript-${version}"
    git add --all
    git commit -m "Update TS SDK to ${version}"
    git push

    gh pr create \
        --title "Update TS SDK to ${version}" \
        --body "## What changed"$'\n\n'"- Update TS SDK to ${version}" \
        --head "typescript-${version}"
  )

  # Update the Omes repo
  (
    git clone --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/omes.git
    cd omes

    # Note this only update _regular_ dependencies. There's no dev/peer dependencies at the moment.
    npm install $(jq -r '.dependencies | keys[] | select(startswith("@temporalio/")) | . + "@^" + env.version' package.json)

    git checkout -b "typescript-${version}"
    git add --all
    git commit -m "Update TS SDK to ${version}"
    git push

    gh pr create \
        --title "Update TS SDK to ${version}" \
        --body "## What changed"$'\n\n'"- Update TS SDK to ${version}" \
        --head "typescript-${version}"
  )

  (
    git clone --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/samples-typescript.git
    cd samples-typescript

    npm i

    # Update all samples
    zx .scripts/upgrade-versions.mjs "^${version}"

    # Update the package.json file
    npm i

    git checkout -b "typescript-${version}"
    git add --all
    git commit -m "Update TS SDK to ${version}"
    git push

    gh pr create \
        --title "Update TS SDK to ${version}" \
        --body "## What changed"$'\n\n'"- Update TS SDK to ${version}" \
        --head "typescript-${version}"
  )
fi