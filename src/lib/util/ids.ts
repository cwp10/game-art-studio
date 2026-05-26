import { customAlphabet } from "nanoid";

/**
 * 짧고 URL-safe 한 id. 충돌 위험은 개인용 도구라 무시 가능.
 * 알파벳을 소문자+숫자로 좁혀 더블클릭 선택이 자연스럽게 끊기지 않게.
 */
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

const sessionIdGen = customAlphabet(alphabet, 12);
const messageIdGen = customAlphabet(alphabet, 14);
const generationIdGen = customAlphabet(alphabet, 16);
const jobIdGen = customAlphabet(alphabet, 10);
const presetIdGen = customAlphabet(alphabet, 10);
const promptIdGen = customAlphabet(alphabet, 10);

export const newSessionId = () => sessionIdGen();
export const newMessageId = () => messageIdGen();
export const newGenerationId = () => generationIdGen();
export const newJobId = () => jobIdGen();
export const newPresetId = () => presetIdGen();
export const newPromptId = () => promptIdGen();

/** 일반 용도. 길이 지정 가능. */
export const newId = (len = 12) => customAlphabet(alphabet, len)();
