import { writeFile } from "fs/promises";
import { program } from "@commander-js/extra-typings";
import { MiroBoard } from "./index.js";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import fetch from "node-fetch";
import type { FrameBoardObject } from "./miro-types.ts";

async function convertSvgImages(svgContent: string, authToken?: string): Promise<string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');

  const images = doc.getElementsByTagName('image');

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const href = image.getAttribute('xlink:href') || image.getAttribute('href');

    if (href && href.startsWith('http')) {
      try {
        const headers: Record<string, string> = {};
        if (authToken) {
          headers['Cookie'] = `token=${authToken}`;
        }

        const response = await fetch(href, {
          headers
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        // Convert to buffer and then to base64
        const buffer = await response.buffer();
        const base64 = buffer.toString('base64');

        // Determine mime type from response headers or fallback to png
        const contentType = response.headers.get('content-type') || 'image/png';

        // Create the data URL
        const dataUrl = `data:${contentType};base64,${base64}`;

        // Update the image attribute
        image.removeAttribute('xlink:href');
        image.setAttribute('href', dataUrl);

        console.log(`Converted image ${i + 1}/${images.length}`);
      } catch (error) {
        console.error(`Error converting image ${href}:`, error);
      }
    }
  }

  // Serialize back to string
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

const { token, boardId, frameNames, outputFile, exportFormat } = program
  .option("-t, --token <token>", "Miro token")
  .requiredOption("-b, --board-id <boardId>", "The board ID")
  .option(
    "-f, --frame-names <frameNames...>",
    "The frame name(s), leave empty to export entire board"
  )
  .option(
    "-o, --output-file <filename>",
    "A file to output the SVG to (stdout if not supplied)"
  )
  .option("-e, --export-format <format>", "'svg' or 'json' (default: 'svg')")
  .parse()
  .opts();

(async () => {
  await using miroBoard = new MiroBoard({ token, boardId });

  async function getFrames(frameNames: string[]) {
    const frames = await miroBoard.getBoardObjects(
      { type: "frame" as const },
      { title: frameNames }
    );

    if (frames && frames.length !== frameNames.length) {
      throw Error(
        `${
          frameNames.length - frames.length
        } frame(s) could not be found on the board.`
      );
    }

    return frames;
  }

  async function getSvg(frames?: FrameBoardObject[]) {
    const svg = await miroBoard.getSvg(
      frames?.map(({ id }) => id).filter((id): id is string => !!id)
    );
    // Convert images in SVG to base64
    return await convertSvgImages(svg, token);
  }

  async function getJson(frames?: FrameBoardObject[]) {
    if (frames) {
      const frameChildren = await miroBoard.getBoardObjects({
        id: frames.flatMap((frame) => frame.childrenIds)
      });

      const groupChildren = await miroBoard.getBoardObjects({
        id: frameChildren
          .filter((child) => child.type === "group")
          .flatMap((child) => child.itemsIds)
      });

      return JSON.stringify([...frames, ...frameChildren, ...groupChildren]);
    }

    return JSON.stringify(await miroBoard.getBoardObjects({}));
  }

  const getFn = exportFormat === "json" ? getJson : getSvg;

  if (outputFile?.includes("{frameName}")) {
    if (!frameNames) {
      throw Error(
        "Expected frame names to be given when the output file name format expects a frame name."
      );
    }

    for (const frameName of frameNames) {
      const output = await getFn(await getFrames([frameName]));
      await writeFile(outputFile.replace("{frameName}", frameName), output);
    }
  } else {
    const svg = await getFn(frameNames && (await getFrames(frameNames)));
    if (outputFile) {
      await writeFile(outputFile, svg);
    } else {
      process.stdout.write(svg);
    }
  }
})();
