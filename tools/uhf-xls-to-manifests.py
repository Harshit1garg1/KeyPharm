"""Convert a Chainway UHF XLS export into Keypharm test manifests."""
import argparse
import csv
import re
from pathlib import Path

import xlrd


def read_epcs(source):
    sheet = xlrd.open_workbook(source).sheet_by_index(0)
    headers = [str(value).strip().upper() for value in sheet.row_values(0)] if sheet.nrows else []
    if headers.count("EPC") != 1:
        raise ValueError("Expected exactly one EPC column in the first worksheet.")
    epcs = []
    seen = set()
    for index, value in enumerate(sheet.col_values(headers.index("EPC"), start_rowx=1), start=2):
        if value == "":
            continue
        epc = str(value).strip().upper()
        if not re.fullmatch(r"(?:[0-9A-F]{2}){2,31}", epc):
            raise ValueError(f"Excel row {index}: invalid EPC.")
        if epc in seen:
            raise ValueError(f"Excel row {index}: duplicate EPC.")
        epcs.append(epc)
        seen.add(epc)
    return epcs


def write_manifests(epcs, output, tags_per_pallet):
    groups = [epcs[i:i + tags_per_pallet] for i in range(0, len(epcs), tags_per_pallet)]
    if not groups or len(groups[-1]) < 2:
        raise ValueError("Each group needs at least one pallet tag and one carton tag. Adjust --tags-per-pallet.")
    paths = [output / f"KP-LIVE-{i:02}.csv" for i in range(1, len(groups) + 1)]
    if any(path.exists() for path in paths):
        raise ValueError("A manifest already exists in that output folder. Choose another folder.")
    output.mkdir(parents=True, exist_ok=True)
    for path, (pallet_epc, *cartons) in zip(paths, groups):
        with path.open("x", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(["pallet_ref", "pallet_epc", "carton_ref", "carton_epc", "sku"])
            for number, epc in enumerate(cartons, start=1):
                writer.writerow([path.stem, pallet_epc, f"Carton {number:02}", epc, "POC tag test"])
        print(f"{path}: 1 pallet tag and {len(cartons)} carton tags")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Chainway UHF .xls export")
    parser.add_argument("output", type=Path, help="Folder for the generated CSV manifests")
    parser.add_argument("--tags-per-pallet", type=int, default=14, choices=range(2, 15), metavar="2–14")
    args = parser.parse_args()
    try:
        if args.source.suffix.lower() != ".xls":
            raise ValueError("Use a UHF .xls export.")
        write_manifests(read_epcs(args.source), args.output, args.tags_per_pallet)
    except (OSError, ValueError, xlrd.XLRDError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
