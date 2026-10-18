"""Verifies parameters passed to each nested stack match the child template."""
import sys
from pathlib import Path

import yaml


class Loader(yaml.SafeLoader):
    pass


def _any(loader, suffix, node):
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    return loader.construct_scalar(node)


Loader.add_multi_constructor("!", _any)
root = Path(__file__).resolve().parents[1]
parent = yaml.load((root / "main.yml").read_text(), Loader=Loader)
ok = True
for name, res in parent["Resources"].items():
    if res["Type"] != "AWS::CloudFormation::Stack":
        continue
    child = yaml.load((root / res["Properties"]["TemplateURL"]).read_text(), Loader=Loader)
    declared = child.get("Parameters", {})
    passed = set(res["Properties"].get("Parameters", {}))
    unknown = passed - set(declared)
    missing = {p for p, d in declared.items() if "Default" not in d} - passed
    outputs = set(child.get("Outputs", {}))
    print(f"{name:14s} passed={len(passed):2d} unknown={sorted(unknown)} missing={sorted(missing)}")
    ok &= not unknown and not missing
    # every Outputs reference to this child must exist
    text = (root / "main.yml").read_text()
    import re
    for ref in set(re.findall(rf"{name}\.Outputs\.(\w+)", text)):
        if ref not in outputs:
            print(f"   !! {name}.Outputs.{ref} does not exist")
            ok = False
sys.exit(0 if ok else 1)
