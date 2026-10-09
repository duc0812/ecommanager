import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# Real PSDs on the owner's PC. Opened read-only; tests skip when they are absent.
DES1 = r'D:\Downloads\21-7 DES1.psd'
DC = r'D:\Downloads\DC100701HO.psd'
MALONE = r'D:\Downloadn\TEE_MALONE.psd'
CROCS = r'D:\Downloadn\designs_5f6b19b3112ee364cc787c49_quai-dep-crocs.psd'
MYRIAD_BOLD = r'C:\Windows\Fonts\MyriadPro-Bold.otf'
ARIAL = r'C:\Windows\Fonts\arial.ttf'
# HaPo tumbler: "Custom Name" placed twice (one per side), gold gradient + bevel + drop shadow on the type layers.
HAPO = r'D:\Downloads\DN2509261948 - 20OZ_CUSTOM NAME (chuan).psd'
HAPO_UNNAMED = r'D:\Downloads\DN2509261948 - 20OZ_CUSTOM NAME.psd'
HARRYP = r'D:\TIKTOK SHOP TOOL\Tool Auto Mockup\Fonts\HARRYP_.TTF'


def need(*paths):
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        pytest.skip(f'missing local file(s): {missing}')
