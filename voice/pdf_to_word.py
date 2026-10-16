"""PDF to Word for second-brain/pdftools.js: pdf_to_word.py in.pdf out.docx (pdf2docx, as PDFCraft uses)."""
import logging
import sys

from pdf2docx import Converter

logging.disable(logging.WARNING)
source, target = sys.argv[1], sys.argv[2]
converter = Converter(source)
try:
    converter.convert(target)
finally:
    converter.close()
